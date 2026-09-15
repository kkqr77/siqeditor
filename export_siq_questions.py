"""Export the playable contents of SIQ packages to readable UTF-8 text files."""

from __future__ import annotations

import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "questions_answers"


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def clean(text: str | None) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def content(param: ET.Element | None) -> str:
    """Turn SIQ's mixed text/media content into a compact text representation."""
    if param is None:
        return "—"

    parts: list[str] = []
    for item in param.iter():
        if local_name(item.tag) != "item":
            continue
        value = clean("".join(item.itertext()))
        media_type = item.get("type", "text")
        if media_type == "text":
            if value:
                parts.append(value)
        else:
            label = {
                "image": "изображение",
                "audio": "аудио",
                "video": "видео",
            }.get(media_type, media_type)
            parts.append(f"[{label}: {value or 'без имени'}]")
    return " ".join(parts) or "—"


def param(question: ET.Element, name: str) -> ET.Element | None:
    for element in question.iter():
        if local_name(element.tag) == "param" and element.get("name") == name:
            return element
    return None


def export_package(package: Path) -> tuple[Path, int]:
    with zipfile.ZipFile(package) as archive:
        root = ET.fromstring(archive.read("content.xml"))

    package_name = root.get("name", package.stem)
    lines = [
        package_name,
        "=" * len(package_name),
        f"Исходный файл: {package.name}",
        "",
    ]
    question_count = 0
    round_number = 0

    for round_element in root.iter():
        if local_name(round_element.tag) != "round":
            continue
        round_number += 1
        round_name = round_element.get("name", str(round_number))
        lines.extend([f"РАУНД {round_number}: {round_name}", ""])

        for theme in round_element.iter():
            if local_name(theme.tag) != "theme":
                continue
            # Nested themes are not used by SIQ; this guards against duplicate walk.
            if theme is not round_element and any(
                local_name(parent.tag) == "theme" for parent in ()
            ):
                continue
            theme_name = theme.get("name", "Без названия")
            questions = [
                q for q in theme.iter() if local_name(q.tag) == "question"
            ]
            if not questions:
                continue
            lines.extend([f"ТЕМА: {theme_name}", "-" * 60])

            for index, question in enumerate(questions, 1):
                question_count += 1
                price = question.get("price", "—")
                question_type = question.get("type", "simple")
                answers = [
                    clean("".join(answer.itertext()))
                    for answer in question.iter()
                    if local_name(answer.tag) == "answer"
                ]
                lines.append(f"{index}. Цена: {price}; тип: {question_type}")
                lines.append(f"Вопрос: {content(param(question, 'question'))}")
                extra_answer = content(param(question, "answer"))
                if extra_answer != "—":
                    lines.append(f"Материал к ответу: {extra_answer}")
                lines.append("Ответ: " + (" / ".join(answers) if answers else "—"))
                lines.append("")

    output = OUTPUT_DIR / f"{package.stem}.txt"
    output.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return output, question_count


def main() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    results = [export_package(package) for package in sorted(ROOT.glob("*.siq"))]
    for output, count in results:
        print(f"{output.name}: {count} вопросов")


if __name__ == "__main__":
    main()
