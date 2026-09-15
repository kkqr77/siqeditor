"""SIQ compressor: repacks a .siq with maximum deflate, drops unused media files,
deduplicates identical files and losslessly re-encodes PNG images.

Usage: python compress_siq.py <pack.siq> [--out result.siq] [--keep-unused] [--strip-id3]
       python compress_siq.py <pack.siq> --transcode [--video-crf 29] [--image-quality 85]
Nothing touches audio/video pixels or JPEG data without --transcode. With --transcode
videos are re-encoded in H.264 and JPEGs re-saved at --image-quality; a video is kept
untouched unless the result is smaller AND its SSIM is at least --ssim-min (default 0.98).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

try:
    from PIL import Image  # type: ignore
except ImportError:
    Image = None  # type: ignore

SERVICE_FILES = {'content.xml', '[Content_Types].xml', 'quality.marker', 'Texts/authors.xml', 'Texts/sources.xml'}
MEDIA_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.mp3', '.ogg', '.wav', '.mp4', '.avi', '.mov', '.webm', '.silk'}


def basename(path: str) -> str:
    return path.rsplit('/', 1)[-1]


def collect_refs(root: ET.Element) -> set[str]:
    """Names of files the pack actually references (isRef items, v4 atoms, @-attributes)."""
    refs: set[str] = set()
    for el in root.iter():
        tag = el.tag.rsplit('}', 1)[-1]
        if tag == 'item' and (el.get('isRef') or '').lower() == 'true':
            value = (el.text or '').strip()
            if value:
                refs.add(basename(value))
        elif tag == 'atom':
            atom_type = el.get('type') or 'text'
            value = (el.text or '').strip()
            if atom_type in ('image', 'audio', 'video') and value.startswith('@'):
                refs.add(basename(value[1:]))
        for attr in el.attrib.values():
            value = attr.strip()
            if value.startswith('@') and '/' not in value:
                refs.add(value[1:])
    return refs


def rewrite_refs(root: ET.Element, remap: dict[str, str]) -> int:
    changed = 0
    for el in root.iter():
        tag = el.tag.rsplit('}', 1)[-1]
        if tag == 'item' and (el.get('isRef') or '').lower() == 'true':
            value = (el.text or '').strip()
            if value in remap:
                el.text = remap[value]
                changed += 1
        elif tag == 'atom':
            value = (el.text or '').strip()
            if value.startswith('@') and basename(value[1:]) in remap:
                el.text = '@' + remap[basename(value[1:])]
                changed += 1
    return changed


def strip_id3(data: bytes) -> bytes:
    if data[:3] == b'ID3':
        size = ((data[6] & 0x7F) << 21) | ((data[7] & 0x7F) << 14) | ((data[8] & 0x7F) << 7) | (data[9] & 0x7F)
        return data[10 + size:]
    return data


PNG_SAFE_MODES = {'1', 'L', 'LA', 'P', 'PA', 'RGB', 'RGBA'}


def optimize_png(data: bytes) -> bytes | None:
    """Losslessly re-encodes a PNG; verifies decoded pixels are identical."""
    if Image is None or len(data) < 10_000:
        return None
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
        if (im.format or '').upper() != 'PNG' or im.mode not in PNG_SAFE_MODES:
            return None
        target = 'RGBA' if (im.mode in ('RGBA', 'LA', 'P', 'PA') or 'transparency' in im.info) else 'RGB'
        reference = im.convert(target).tobytes()
        buf = io.BytesIO()
        im.save(buf, format='PNG', optimize=True, compress_level=9)
        new = buf.getvalue()
        if len(new) >= len(data):
            return None
        recheck = Image.open(io.BytesIO(new))
        recheck.load()
        if recheck.convert(target).tobytes() != reference:
            return None
        return new
    except Exception:
        return None


def have_ffmpeg() -> bool:
    return bool(shutil.which('ffmpeg') and shutil.which('ffprobe'))


def ffmpeg_ssim(original: Path, candidate: Path) -> float:
    """SSIM между двумя видеофайлами (1.0 = идентично) или 0 при неудаче."""
    try:
        r = subprocess.run(['ffmpeg', '-v', 'info', '-i', str(candidate), '-i', str(original),
                            '-lavfi', 'ssim', '-f', 'null', '-'],
                           capture_output=True, text=True, timeout=1800)
    except Exception:
        return 0.0
    m = re.search(r'All:([0-9.]+)', r.stderr or '')
    return float(m.group(1)) if m else 0.0


def transcode_video(data: bytes, workdir: Path, crfs: list[int], preset: str, ssim_min: float):
    """Перекодирует mp4 в H.264 с меньшим размером, аудио копируется как есть.

    Возвращает (bytes, crf, ssim) либо None, если ни один CRF не дал файл меньше
    исходного с SSIM не ниже порога (тогда исходник не трогаем)."""
    src = workdir / 'in.mp4'
    src.write_bytes(data)
    candidates: list[tuple[int, int, Path]] = []  # (size, crf, path)
    for crf in crfs:
        out = workdir / f'out{crf}.mp4'
        try:
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(src), '-c:v', 'libx264',
                            '-crf', str(crf), '-preset', preset, '-pix_fmt', 'yuv420p',
                            '-c:a', 'copy', '-movflags', '+faststart', str(out)],
                           capture_output=True, timeout=3600)
        except Exception:
            continue
        if out.exists() and out.stat().st_size:
            candidates.append((out.stat().st_size, crf, out))
    for size, crf, out in sorted(candidates):
        if size >= len(data) * 0.98:
            continue
        value = ffmpeg_ssim(src, out)
        if value >= ssim_min:
            return out.read_bytes(), crf, value
    return None


def reencode_jpeg(data: bytes, quality: int) -> bytes | None:
    """Пересжатие JPEG в q=quality (progressive, 4:2:0). Возвращает None, если не выиграло."""
    if Image is None:
        return None
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
        if (im.format or '').upper() not in ('JPEG', 'MPO'):
            return None
        im = im.convert('RGB')
        buf = io.BytesIO()
        im.save(buf, 'JPEG', quality=quality, optimize=True, progressive=True, subsampling=2)
        new = buf.getvalue()
        return new if len(new) < len(data) else None
    except Exception:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--keep-unused', action='store_true', help='не удалять файлы, на которые нет ссылок в content.xml')
    parser.add_argument('--strip-id3', action='store_true', help='срезать ID3v2-теги у mp3 (метаданные, звук не трогается)')
    parser.add_argument('--transcode', action='store_true',
                        help='С ПОТЕРЯМИ: перекодировать видео (H.264) и JPEG для сильного уменьшения размера')
    parser.add_argument('--video-crf', type=int, default=29,
                        help='максимальный CRF видео для --transcode (меньше = качественнее и больше; по умолчанию 29)')
    parser.add_argument('--preset', default='fast', help='preset x264 для --transcode (по умолчанию fast)')
    parser.add_argument('--ssim-min', type=float, default=0.98,
                        help='минимальный SSIM, при котором принимается перекодированное видео (по умолчанию 0.98)')
    parser.add_argument('--image-quality', type=int, default=85,
                        help='качество JPEG для --transcode (по умолчанию 85)')
    args = parser.parse_args()

    src: Path = args.input
    out: Path = args.out or src.with_name(src.stem + '.min.siq')
    with zipfile.ZipFile(src) as z:
        infos = z.infolist()
        entries = [(i, z.read(i.filename)) for i in infos if not i.is_dir()]
        raw_xml = z.read('content.xml')
    root = ET.fromstring(raw_xml)
    refs = collect_refs(root)

    # 1. Удаление неиспользуемых файлов
    kept: list[tuple[zipfile.ZipInfo, bytes]] = []
    removed_unused = 0
    removed_unused_bytes = 0
    for info, data in entries:
        name = info.filename
        if name in SERVICE_FILES or not Path(name).suffix.lower() in MEDIA_EXT:
            kept.append((info, data))
            continue
        if basename(name) in refs or args.keep_unused:
            kept.append((info, data))
        else:
            removed_unused += 1
            removed_unused_bytes += len(data)

    # 2. Дедупликация одинаковых файлов
    by_hash: dict[str, str] = {}
    remap: dict[str, str] = {}
    deduped: list[tuple[zipfile.ZipInfo, bytes]] = []
    deduped_bytes = 0
    for info, data in kept:
        if basename(info.filename) in refs:
            digest = hashlib.sha256(data).hexdigest()
            if digest in by_hash:
                remap[basename(info.filename)] = by_hash[digest]
                deduped_bytes += len(data)
                continue
            by_hash[digest] = basename(info.filename)
        deduped.append((info, data))
    if remap and rewrite_refs(root, remap):
        raw_xml = ET.tostring(root, encoding='utf-8', xml_declaration=True)

    # 3. Безопасная пересборка PNG
    png_saved = 0
    png_count = 0
    if Image is not None:
        repacked: list[tuple[zipfile.ZipInfo, bytes]] = []
        for info, data in deduped:
            if info.filename.lower().endswith('.png'):
                optimized = optimize_png(data)
                if optimized is not None:
                    png_saved += len(data) - len(optimized)
                    png_count += 1
                    data = optimized
            repacked.append((info, data))
        deduped = repacked

    # 4. С потерями: видео и JPEG (только при --transcode)
    video_saved = video_count = image_saved = image_count = video_kept = 0
    video_crfs: dict[int, int] = {}
    if args.transcode:
        ffmpeg_ok = have_ffmpeg()
        if not ffmpeg_ok:
            print('Внимание: ffmpeg/ffprobe не найдены в PATH - видео пропущено.', file=sys.stderr)
        crfs = sorted({23, 26, args.video_crf})
        with tempfile.TemporaryDirectory() as td_name:
            workdir = Path(td_name)
            done: list[tuple[zipfile.ZipInfo, bytes]] = []
            for info, data in deduped:
                low = info.filename.lower()
                if ffmpeg_ok and low.endswith(('.mp4', '.mov', '.webm', '.avi')):
                    result_v = transcode_video(data, workdir, crfs, args.preset, args.ssim_min)
                    if result_v is None:
                        video_kept += 1
                    else:
                        new_data, crf, _ssim = result_v
                        video_saved += len(data) - len(new_data)
                        video_count += 1
                        video_crfs[crf] = video_crfs.get(crf, 0) + 1
                        data = new_data
                elif low.endswith(('.jpg', '.jpeg')):
                    new_data = reencode_jpeg(data, args.image_quality)
                    if new_data is not None:
                        image_saved += len(data) - len(new_data)
                        image_count += 1
                        data = new_data
                done.append((info, data))
            deduped = done

    # 5. Запись с максимальным deflate
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zo:
        for info, data in deduped:
            if args.strip_id3 and info.filename.lower().endswith('.mp3'):
                data = strip_id3(data)
            zo.writestr(info.filename, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

    original = src.stat().st_size
    result = out.stat().st_size
    print(f'Исходник:     {original/1e6:8.2f} MB  ({src.name})')
    print(f'Результат:    {result/1e6:8.2f} MB  ({out.name})')
    print(f'Экономия:     {(original-result)/1e6:8.2f} MB  ({100*(original-result)/max(original,1):.1f}%)')
    print(f'  убрано неиспользуемых файлов: {removed_unused} ({removed_unused_bytes/1e6:.2f} MB)')
    print(f'  дубликатов удалено: {len(remap)} ({deduped_bytes/1e6:.2f} MB)')
    print(f'  PNG пересобрано без потерь: {png_count} ({png_saved/1e6:.2f} MB)')
    if args.transcode:
        detail = ', '.join(f'CRF{k}={v}' for k, v in sorted(video_crfs.items())) or 'нет'
        print(f'  видео перекодировано: {video_count} ({video_saved/1e6:.2f} MB), не тронуто {video_kept} [{detail}]')
        print(f'  JPEG пересжато q={args.image_quality}: {image_count} ({image_saved/1e6:.2f} MB)')
    else:
        print('  остальное - пересжатие ZIP (STORE -> deflate-9)')


if __name__ == '__main__':
    main()


