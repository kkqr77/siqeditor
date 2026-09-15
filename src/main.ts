import JSZip from 'jszip';
import './style.css';

type Pack = { name: string; doc: XMLDocument; zip: JSZip; copied: Map<string, Uint8Array>; legacy: boolean };
type Selection = { pack: 'source' | 'target'; element: Element } | null;

const NS = 'https://github.com/VladimirKhil/SI/blob/master/assets/siq_5.xsd';
const V4 = 'http://vladimirkhil.com/ygpackage3.0.xsd'; // пакеты старого формата SIQ4
let source: Pack | null = null;
let target: Pack | null = null;
let selected: Selection = null;
let message = '';
let lastDestination = '';

const app = document.querySelector<HTMLDivElement>('#app')!;
const local = (e: Element) => e.localName || e.tagName;
const children = (e: Element, tag: string) => [...e.children].filter(x => local(x) === tag);
const first = (e: Element, tag: string) => children(e, tag)[0];
const text = (e?: Element) => e?.textContent?.trim() || '';
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));

function el(doc: XMLDocument, tag: string, attrs: Record<string, string> = {}) {
  const node = doc.createElementNS(NS, tag); Object.entries(attrs).forEach(([k,v]) => node.setAttribute(k,v)); return node;
}

async function loadPack(file: File): Promise<Pack> {
  const zip = await JSZip.loadAsync(file);
  const xmlFile = zip.file('content.xml');
  if (!xmlFile) throw new Error('В архиве не найден content.xml');
  const doc = new DOMParser().parseFromString(await xmlFile.async('text'), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Не удалось прочитать content.xml');
  const ns = doc.documentElement.namespaceURI;
  if (ns !== NS && ns !== V4) throw new Error('Неподдерживаемый формат пакета (ожидается SIQ4 или SIQ5)');
  const legacy = ns === V4;
  return { name: doc.documentElement.getAttribute('name') || file.name.replace(/\.siq$/i,''), doc: legacy ? convertV4(doc) : doc, zip, copied: new Map(), legacy };
}

// Конвертация SIQ4 (ygpackage3.0) → SIQ5 в памяти: редактор работает только с пятой версией формата.
// Отличия: у вопроса вместо атрибута type вложен элемент <type name="…">, текст вопроса и материал к ответу
// лежат в <scenario> как <atom> и делятся <atom type="marker"/>, типы названы по-старому
// (cat/sponsored/bagcat), а ссылки на медиа начинаются с "@" (файлы лежат в Images/Audio/Video, часто в URL-кодировке).
const v4TypeMap: Record<string, string> = { sponsored: 'noRisk', cat: 'secret', bagcat: 'secretPublicPrice', auction: 'auction' };

function convertV4(old: XMLDocument): XMLDocument {
  const doc = document.implementation.createDocument(NS, 'package', null);
  const root = doc.documentElement; const oldRoot = old.documentElement;
  const attr = (n: string) => oldRoot.getAttribute(n) || '';
  root.setAttribute('name', attr('name') || 'Пак'); root.setAttribute('version', '5');
  root.setAttribute('date', attr('date') || new Date().toLocaleDateString('ru-RU'));
  ['id', 'difficulty', 'language'].forEach(n => { if (attr(n)) root.setAttribute(n, attr(n)); });
  const tags = el(doc, 'tags'); root.append(tags, el(doc, 'files'));
  [...old.getElementsByTagNameNS(V4, 'tag')].forEach(t => { const tag = el(doc, 'tag'); tag.textContent = text(t); tags.append(tag); });
  const rounds = el(doc, 'rounds'); root.append(rounds);
  [...old.getElementsByTagNameNS(V4, 'round')].forEach(oldRound => {
    const round = el(doc, 'round', { name: oldRound.getAttribute('name') || 'Раунд' }); const themes = el(doc, 'themes'); round.append(themes); rounds.append(round);
    [...oldRound.getElementsByTagNameNS(V4, 'theme')].forEach(oldTheme => {
      const theme = el(doc, 'theme', { name: oldTheme.getAttribute('name') || 'Тема' }); const questions = el(doc, 'questions'); theme.append(questions); themes.append(theme);
      [...oldTheme.getElementsByTagNameNS(V4, 'question')].forEach(oldQ => {
        const q = el(doc, 'question', { price: oldQ.getAttribute('price') || '100' });
        const params = el(doc, 'params'); q.append(params);
        const atoms = [...oldQ.getElementsByTagNameNS(V4, 'atom')];
        const marker = atoms.findIndex(a => a.getAttribute('type') === 'marker');
        const addContent = (paramName: string, list: Element[]) => {
          if (!list.length) return;
          const param = el(doc, 'param', { name: paramName, type: 'content' });
          list.forEach(atom => {
            const raw = (atom.textContent || '').trim(); const atomType = atom.getAttribute('type') || 'text';
            const type = atomType === 'voice' ? 'audio' : atomType; // в SIQ4 аудиофайлы помечены как voice
            const value = raw.replace(/^@/, '');
            const external = /^(https?:)?\/\//i.test(value);
            const item = type === 'image' || type === 'audio' || type === 'video' ? el(doc, 'item', { type, ...(external ? {} : { isRef: 'True' }) }) : el(doc, 'item');
            item.textContent = value;
            ['placement', 'duration', 'waitForFinish'].forEach(x => { const v = atom.getAttribute(x); if (v) item.setAttribute(x, v); });
            param.append(item);
          });
          params.append(param);
        };
        addContent('question', marker >= 0 ? atoms.slice(0, marker) : atoms);
        addContent('answer', marker >= 0 ? atoms.slice(marker + 1) : []);
        const oldType = oldQ.getElementsByTagNameNS(V4, 'type')[0];
        if (oldType) {
          const gameType = v4TypeMap[oldType.getAttribute('name') || 'simple'];
          if (gameType) {
            q.setAttribute('type', gameType);
            if (gameType === 'secret' || gameType === 'secretPublicPrice') {
              const sel = el(doc, 'param', { name: 'selectionMode' }); sel.textContent = gameType === 'secret' ? 'exceptCurrent' : 'any'; params.append(sel);
              const themeParam = el(doc, 'param', { name: 'theme' });
              themeParam.textContent = text([...oldType.children].find(c => local(c) === 'param' && c.getAttribute('name') === 'theme'));
              params.append(themeParam);
              const priceSet = el(doc, 'param', { name: 'price', type: 'numberSet' }); priceSet.append(el(doc, 'numberSet', { minimum: '0', maximum: '0', step: '0' })); params.append(priceSet);
              const cost = text([...oldType.children].find(c => local(c) === 'param' && c.getAttribute('name') === 'cost'));
              if (Number(cost) > 0) q.setAttribute('price', String(Number(cost)));
            }
          }
        }
        const right = el(doc, 'right');
        const rightOld = oldQ.getElementsByTagNameNS(V4, 'right')[0];
        (rightOld ? [...rightOld.children].filter(c => local(c) === 'answer') : []).forEach(ans => { const a = el(doc, 'answer'); a.textContent = ans.textContent; right.append(a); });
        q.append(right);
        const wrongs = [...oldQ.getElementsByTagNameNS(V4, 'wrong')];
        if (wrongs.length) { const wrong = el(doc, 'wrong'); wrongs.forEach(w => [...w.children].filter(c => local(c) === 'answer').forEach(ans => { const a = el(doc, 'answer'); a.textContent = ans.textContent; wrong.append(a); })); q.append(wrong); }
        questions.append(q);
      });
    });
  });
  return doc;
}

function newPack(): Pack {
  const doc = document.implementation.createDocument(NS, 'package', null);
  const root = doc.documentElement;
  root.setAttribute('name', 'Новый пакет'); root.setAttribute('version','5'); root.setAttribute('date', new Date().toLocaleDateString('ru-RU')); root.setAttribute('language','ru-RU');
  root.append(el(doc,'tags')); root.append(el(doc,'files')); const rounds = el(doc,'rounds'); root.append(rounds);
  for (let r=1; r<=3; r++) { const round = el(doc,'round',{name:`Раунд ${r}`}); const themes=el(doc,'themes'); round.append(themes); rounds.append(round); for(let t=1;t<=5;t++) { const theme=el(doc,'theme',{name:`Тема ${t}`}); theme.append(el(doc,'questions')); themes.append(theme); } }
  return { name:'Новый пакет', doc, zip:new JSZip(), copied:new Map(), legacy:false };
}

function getRounds(pack: Pack) { const rounds = [...pack.doc.documentElement.getElementsByTagNameNS(NS,'round')]; return rounds; }
function getThemes(round: Element) { return children(first(round,'themes')!, 'theme'); }
function questionPrice(question: Element) {
  const value=Number(question.getAttribute('price'));
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}
function getQuestions(theme: Element) { return children(first(theme,'questions')!, 'question').sort((a,b)=>questionPrice(a)-questionPrice(b)); }
function sortThemeQuestions(theme: Element) { const container=first(theme,'questions')!; getQuestions(theme).forEach(question=>container.append(question)); }
function sortAllQuestions(pack: Pack) { getRounds(pack).forEach(round=>getThemes(round).forEach(sortThemeQuestions)); }
function questionText(q: Element) { const p = children(first(q,'params')!, 'param').find(x=>x.getAttribute('name')==='question'); return text(p) || '[медиа-вопрос]'; }

const gameTypes: Array<[string,string]>=[['simple','Обычный'],['noRisk','Без риска'],['secret','Кот в мешке'],['secretPublicPrice','Кот: открытая цена'],['stake','Ставка'],['stakeAll','Ва-банк'],['forAll','Для всех'],['auction','Аукцион']];
const answerTypes: Array<[string,string]>=[['text','Текстовый'],['select','Выбор варианта'],['point','Точка на изображении']];
const typeLabel=(list: Array<[string,string]>, key: string)=>list.find(([k])=>k===key)?.[1] || key;

function paramValue(q: Element, name: string) { return text(children(first(q,'params')!, 'param').find(p=>p.getAttribute('name')===name)); }
function answerKindOf(q: Element) { return paramValue(q,'answerType') || 'text'; }
function pointCoords(q: Element): [number, number] | null {
  if (answerKindOf(q)!=='point') return null;
  const value=[...q.getElementsByTagNameNS(NS,'answer')].map(text).find(Boolean); if (!value) return null;
  const parts=value.split(',').map(s=>Number(s.trim()));
  return parts.length>=2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && parts[0]>=0 && parts[0]<=1 && parts[1]>=0 && parts[1]<=1 ? [parts[0],parts[1]] : null;
}

function tree(pack: Pack, side: 'source'|'target') {
  const canCopy = side === 'source' && target;
  const canEdit = side === 'target';
  return getRounds(pack).map((round, ri) => `<section class="round"><div class="round-title">▾ ${esc(round.getAttribute('name') || `Раунд ${ri+1}`)}${canCopy?` <button class="mini copy-round" data-r="${ri}">Копировать раунд</button>`:''}${canEdit?` <button class="mini edit-round" data-r="${ri}">Переим.</button><button class="mini add-theme" data-r="${ri}">+ тема</button><button class="mini delete-round" data-r="${ri}">Удалить</button>`:''}</div>${getThemes(round).map((theme,ti)=>`<div class="theme"><div class="theme-title">▾ ${esc(theme.getAttribute('name')||`Тема ${ti+1}`)} <span class="tag">${getQuestions(theme).length}</span>${canCopy?` <button class="mini copy-theme" data-r="${ri}" data-t="${ti}">Копировать тему</button>`:''}${canEdit?` <button class="mini edit-theme" data-r="${ri}" data-t="${ti}">Переим.</button><button class="mini add-question" data-r="${ri}" data-t="${ti}">+ вопрос</button><button class="mini delete-theme" data-r="${ri}" data-t="${ti}">Удалить</button>`:''}</div><div class="questions">${getQuestions(theme).map((q,qi)=>{const gt=q.getAttribute('type')||'simple',ak=answerKindOf(q);const tags=[gt!=='simple'?`<span class="tag">${esc(typeLabel(gameTypes,gt))}</span>`:'',ak!=='text'?`<span class="tag">${esc(typeLabel(answerTypes,ak))}</span>`:''].join('');return `<button class="question ${selected?.element===q?'active':''}" data-side="${side}" data-r="${ri}" data-t="${ti}" data-q="${qi}">${esc(q.getAttribute('price')||'—')}${tags} · ${esc(questionText(q).slice(0,80))}</button>`;}).join('')}</div></div>`).join('')}</section>`).join('');
}

function targetThemes() { if(!target) return ''; const options=getRounds(target).flatMap((r,ri)=>getThemes(r).map((t,ti)=>{ const value=`${ri}:${ti}`; return `<option value="${value}" ${value===lastDestination?'selected':''}>${esc(r.getAttribute('name')||`Раунд ${ri+1}`)} → ${esc(t.getAttribute('name')||`Тема ${ti+1}`)}</option>`; })); if (!options.some(option => option.includes(`value="${lastDestination}"`))) lastDestination=''; return options.join(''); }

function render() {
  const sourceScroll = app.querySelector<HTMLElement>('[data-panel="source"]')?.scrollTop ?? 0;
  const targetScroll = app.querySelector<HTMLElement>('[data-panel="target"]')?.scrollTop ?? 0;
  app.innerHTML = `<header><h1>SIQ Pack Editor</h1><p>Локальный редактор: файлы не покидают браузер</p><span class="notice">${esc(message)}</span></header><main class="layout">
  <section class="panel" data-panel="source"><h2>Пак 1 · отдающий</h2><div class="toolbar"><label class="file">Открыть .siq<input id="source-file" type="file" accept=".siq" /></label></div>${source?`<div class="subtle">${esc(source.name)} · только просмотр${source.legacy?' · SIQ4 → SIQ5':''}</div><div class="tree">${tree(source,'source')}</div>`:'<div class="drop">Выберите исходный пакет</div>'}</section>
  <section class="panel preview"><h2>Предпросмотр</h2>${preview()}</section>
  <section class="panel" data-panel="target"><h2>Пак 2 · принимающий</h2><div class="toolbar"><label class="file">Открыть .siq<input id="target-file" type="file" accept=".siq" /></label><button id="new-pack">Новый пакет</button><button id="add-round" ${target?'':'disabled'}>+ раунд</button><button id="download" ${target?'':'disabled'}>Скачать .siq</button></div>${target?`<div class="subtle">${esc(target.name)} · редактируется${target.legacy?' · SIQ4 → SIQ5':''}</div><div class="editor"><label>Название пакета<input id="pack-name" value="${esc(target.doc.documentElement.getAttribute('name')||'')}" /></label></div><div class="tree">${tree(target,'target')}</div>`:'<div class="drop">Откройте готовый .siq или создайте пустой</div>'}</section></main>`;
  app.querySelector<HTMLElement>('[data-panel="source"]')!.scrollTop = sourceScroll;
  app.querySelector<HTMLElement>('[data-panel="target"]')!.scrollTop = targetScroll;
  bind();
  void media();
}

function itemPreview(item: Element, pack: Pack, paramName: string) {
 const type=item.getAttribute('type')||'text', value=text(item); if(type==='text') return `<div class="preview-item">${esc(value)}</div>`;
 if(/^(https?:)?\/\//i.test(value)) return `<div class="preview-item media" data-url="${esc(value)}" data-type="${esc(type)}" data-param="${esc(paramName)}">[Загрузка ${esc(type)}…]</div>`;
 const path = findFile(pack, value); if(!path) return `<div class="preview-item">[${esc(type)}: ${esc(value)} — файл не найден]</div>`;
 const f=pack.zip.file(path); const copy=pack.copied.get(path); if(!f && !copy) return `<div class="preview-item">[${esc(type)}: ${esc(value)}]</div>`;
 return `<div class="preview-item media" data-file="${esc(path)}" data-type="${type}" data-param="${esc(paramName)}">[Загрузка ${esc(type)}…]</div>`;
}

function preview() {
 if(!selected) return '<p class="subtle">Выберите вопрос в одном из паков.</p>';
 const pack=selected.pack==='source'?source:target; if(!pack) return '';
 const q=selected.element; const params=children(first(q,'params')!, 'param'); const questionItems=params.filter(p=>p.getAttribute('name')==='question').flatMap(p=>[...p.children]); const answer=params.find(p=>p.getAttribute('name')==='answer'); const options=params.find(p=>p.getAttribute('name')==='answerOptions'); const answers=[...q.getElementsByTagNameNS(NS,'answer')].map(text).filter(Boolean);
 const gameType=q.getAttribute('type')||'simple'; const answerKind=answerKindOf(q); const deviation=paramValue(q,'answerDeviation');
 const optionNodes=options ? children(options,'param') : []; const optionMap=new Map(optionNodes.map(option=>[option.getAttribute('name')||'', text(option)]));
 const choices=optionNodes.length ? `<h3>Варианты ответа</h3>${optionNodes.map(option=>`<div class="preview-item"><b>${esc(option.getAttribute('name')||'')}</b> — ${[...option.children].map(x=>itemPreview(x,pack,'answerOptions')).join('') || esc(text(option))}</div>`).join('')}` : '';
 const correct=answers.map(answerText=>optionMap.has(answerText)?`${answerText} — ${optionMap.get(answerText)}`:answerText).join(' / ');
 const answerDisplay=answerKind==='point'?answers.map(a=>{const p=a.split(',').map(s=>s.trim());return p.length>=2?`точка (${p[0]}, ${p[1]})`:a;}).join(' / ')||'—':correct||'—';
 return `<div class="subtle">Цена: ${esc(q.getAttribute('price')||'—')}; тип: ${esc(typeLabel(gameTypes,gameType))}</div><h3>Вопрос</h3>${questionItems.map(x=>itemPreview(x,pack,'question')).join('')||'—'}${choices}${answer?`<h3>Материал к ответу</h3>${[...answer.children].map(x=>itemPreview(x,pack,'answer')).join('')}`:''}<h3>Верный ответ${answerKind!=='text'?` · ${esc(typeLabel(answerTypes,answerKind))}${answerKind==='point'&&deviation?` (допуск ${esc(deviation)})`:''}`:''}</h3><div class="preview-item answer">${esc(answerDisplay)}</div>${selected.pack==='source'&&target?`<h3>Копирование</h3><select id="destination" class="destination">${targetThemes()}</select><button id="copy-question" style="margin-top:8px">Скопировать в выбранную тему</button>`:selected.pack==='target'?editor(q):''}`;
}

function editor(q: Element) {
  const params=first(q,'params')!;
  const questionItems=children(params,'param').filter(x=>x.getAttribute('name')==='question').flatMap(p=>[...p.children]);
  const questionItem=questionItems.find(x=>local(x)==='item' && (!x.getAttribute('type') || x.getAttribute('type')==='text'));
  const answer=[...q.getElementsByTagNameNS(NS,'answer')][0];
  const gameType=q.getAttribute('type') || 'simple';
  const answerKind=answerKindOf(q);
  const deviation=paramValue(q,'answerDeviation');
  const media=(name: string, title: string, inputId: string) => {
    const items=children(params,'param').filter(x=>x.getAttribute('name')===name).flatMap(p=>[...p.children].filter(x=>local(x)==='item' && x.getAttribute('type') && x.getAttribute('type')!=='text'));
    return `<label>${title}<input id="${inputId}" type="file" accept="image/*,audio/*,video/*" multiple /></label>${items.map((item,index)=>`<div class="subtle">${esc(item.getAttribute('type')||'файл')}: ${esc(text(item))} <button class="mini remove-media" data-param="${name}" data-index="${index}">Убрать</button></div>`).join('')}`;
  };
  const pick=(id: string, value: string, options: Array<[string,string]>) => `<select id="${id}">${options.map(([key,label])=>`<option value="${key}" ${key===value?'selected':''}>${label}</option>`).join('')}</select>`;
  const moveOptions=getRounds(target!).flatMap((r,ri)=>getThemes(r).map((t,ti)=>`<option value="${ri}:${ti}">${esc(r.getAttribute('name')||`Раунд ${ri+1}`)} → ${esc(t.getAttribute('name')||`Тема ${ti+1}`)}</option>`)).join('');
  return `<div class="editor"><h3>Редактировать</h3><label>Игровой тип${pick('edit-game-type',gameType,gameTypes)}</label><label>Цена<input id="edit-price" type="number" min="0" step="100" value="${esc(q.getAttribute('price')||'100')}" /></label><label>Тип ответа${pick('edit-answer-type',answerKind,answerTypes)}</label><label>Допуск для точки на изображении (0.01–1)<input id="edit-deviation" type="number" min="0.01" max="1" step="0.01" value="${esc(deviation||'0.05')}" /></label><label>Текст вопроса<textarea id="edit-question" placeholder="Можно оставить пустым для вопроса только с медиа">${esc(text(questionItem))}</textarea></label>${media('question','Добавить медиа к вопросу','question-media')}<label>Первый правильный ответ${answerKind==='point'?'<span class="subtle"> — кликните по изображению выше, чтобы заполнить координаты</span>':''}<input id="edit-answer" value="${esc(text(answer))}" /></label>${media('answer','Добавить медиа к ответу','answer-media')}<button id="save-edit" style="margin-top:9px">Сохранить</button><button id="delete-question" style="margin-left:8px;background:#b91c1c">Удалить вопрос</button><label>Перенести в тему<select id="move-destination" class="destination">${moveOptions}</select></label><button id="move-question" style="margin-top:9px;background:#334155">Перенести в выбранную тему</button></div>`;
}

function findFile(pack: Pack, value: string) {
  const normalized=value.replace(/^@/,'');
  // SIQ writers differ: some percent-encode names in the ZIP ("image%201.jpg"),
  // some keep the leading "@" inside the ZIP entry name ("Audio/@track.mp3").
  const decoded=(() => { try { return decodeURIComponent(normalized); } catch { try { return decodeURI(normalized); } catch { return normalized; } } })();
  const variants=new Set([normalized, decoded, encodeURI(normalized), encodeURI(decoded), encodeURIComponent(normalized), encodeURIComponent(decoded)]);
  const stripAt=(name: string) => { const i=name.lastIndexOf('/'); return i<0 ? name.replace(/^@/,'') : name.slice(0,i+1)+name.slice(i+1).replace(/^@/,''); };
  const matches=(name: string) => { const n=stripAt(name); return [...variants].some(v => n===v || n.endsWith('/'+v)); };
  const direct=Object.keys(pack.zip.files).find(matches) || [...pack.copied.keys()].find(matches);
  if (direct) return direct;
  // Fallback: сравниваем полностью раскодированные имена и NFC-нормализацию —
  // авторы паков кодируют спецсимволы ([ ] & ♪ …) неоднозначно.
  const clean=(s: string) => { try { return decodeURIComponent(s).normalize('NFC'); } catch { return s.normalize('NFC'); } };
  const wanted=[clean(normalized), decoded.normalize('NFC'), normalized.normalize('NFC')];
  const loose=(name: string) => { const c=clean(stripAt(name)); return wanted.some(v => c===v || c.endsWith('/'+v)); };
  return Object.keys(pack.zip.files).find(loose) || [...pack.copied.keys()].find(loose);
}

async function media() { const question=selected?.element ?? null; const pointMode=selected!==null && selected.pack==='target' && answerKindOf(selected.element)==='point'; const marker=question ? pointCoords(question) : null; let markedQuestionImage=false;
  for(const node of document.querySelectorAll<HTMLElement>('.media')) { const pack=selected?.pack==='source'?source:target; const type=node.dataset.type!, isQuestion=node.dataset.param==='question'; let src='';
  if(node.dataset.url) src=node.dataset.url;
  else { if(!pack) continue; const path=node.dataset.file!; const bytes=pack.copied.get(path) || await pack.zip.file(path)?.async('uint8array'); if(!bytes) continue; src=URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer])); }
  node.innerHTML= type==='image'?`<span class="img-wrap"><img class="${pointMode&&isQuestion?'point-picker':''}" src="${src}" alt="Вложение" title="В режиме «Точка на изображении» кликните для установки ответа"/></span>`:type==='audio'?`<audio controls src="${src}"></audio>`:`<video controls src="${src}"></video>`;
  if(type!=='image') continue;
  const wrap=node.querySelector<HTMLElement>('.img-wrap')!;
  if(isQuestion && marker && !markedQuestionImage) { markedQuestionImage=true; wrap.insertAdjacentHTML('beforeend',`<span class="point-marker" style="left:${(marker[0]*100).toFixed(2)}%;top:${(marker[1]*100).toFixed(2)}%"></span>`); }
  if(pointMode && isQuestion) wrap.querySelector<HTMLImageElement>('img')!.addEventListener('click',event=>{const image=event.currentTarget as HTMLImageElement;const rect=image.getBoundingClientRect();const x=(event.clientX-rect.left)/rect.width;const y=(event.clientY-rect.top)/rect.height;const ratio=image.naturalWidth/image.naturalHeight;const input=document.querySelector<HTMLInputElement>('#edit-answer');if(input)input.value=`${x.toFixed(2)},${y.toFixed(2)},${ratio.toFixed(2)}`;let mark=wrap.querySelector<HTMLElement>('.point-marker');if(!mark){wrap.insertAdjacentHTML('beforeend','<span class="point-marker"></span>');mark=wrap.querySelector<HTMLElement>('.point-marker')!;}mark.style.left=`${(x*100).toFixed(2)}%`;mark.style.top=`${(y*100).toFixed(2)}%`;}); } }

async function copyQuestion() { if(!source||!target||!selected||selected.pack!=='source') return; lastDestination=(document.querySelector<HTMLSelectElement>('#destination')!).value; const dest=lastDestination.split(':').map(Number); const theme=getThemes(getRounds(target)[dest[0]])[dest[1]]; const clone=target.doc.importNode(selected.element,true) as Element; first(theme,'questions')!.append(clone); sortThemeQuestions(theme); await copyMedia(selected.element,source,target,clone); message='Вопрос скопирован в принимающий пакет'; render(); }

function moveQuestion() {
  if(!target||!selected||selected.pack!=='target') return;
  const [ri,ti]=(document.querySelector<HTMLSelectElement>('#move-destination')!).value.split(':').map(Number);
  const destTheme=getThemes(getRounds(target)[ri])[ti];
  if(!destTheme) return;
  if(getQuestions(destTheme).includes(selected.element)){message='Вопрос уже находится в этой теме';render();return;}
  let destQuestions=first(destTheme,'questions'); if(!destQuestions){destQuestions=el(target.doc,'questions');destTheme.append(destQuestions);}
  destQuestions.append(selected.element);
  sortThemeQuestions(destTheme);
  message='Вопрос перенесён в выбранную тему';
  render();
}

async function copyTheme(roundIndex: number, themeIndex: number) {
  if (!source || !target) return;
  const labels=getRounds(target).map((r,i)=>`${i+1}. ${r.getAttribute('name') || `Раунд ${i+1}`}`).join('\n');
  const picked=window.prompt(`В какой раунд принимающего пака добавить тему?\n${labels}`, '1');
  const destination=Number(picked)-1;
  if (!Number.isInteger(destination) || !getRounds(target)[destination]) return;
  const original=getThemes(getRounds(source)[roundIndex])[themeIndex];
  const clone=target.doc.importNode(original,true) as Element;
  first(getRounds(target)[destination],'themes')!.append(clone);
  await copyMedia(original,source,target,clone);
  message='Тема скопирована в принимающий пакет'; render();
}

async function copyRound(roundIndex: number) {
  if (!source || !target) return;
  const original=getRounds(source)[roundIndex];
  const clone=target.doc.importNode(original,true) as Element;
  first(target.doc.documentElement,'rounds')!.append(clone);
  await copyMedia(original,source,target,clone);
  message='Раунд скопирован в принимающий пакет'; render();
}

function addRound() {
  if (!target) return;
  const name=window.prompt('Название нового раунда', `Раунд ${getRounds(target).length + 1}`);
  if (!name?.trim()) return;
  const round=el(target.doc,'round',{name:name.trim()}); round.append(el(target.doc,'themes'));
  first(target.doc.documentElement,'rounds')!.append(round);
  message='Раунд добавлен'; render();
}

function renameRound(roundIndex: number) {
  if (!target) return;
  const round=getRounds(target)[roundIndex]; const name=window.prompt('Название раунда',round.getAttribute('name')||'');
  if (!name?.trim()) return; round.setAttribute('name',name.trim()); message='Название раунда изменено'; render();
}

function addTheme(roundIndex: number) {
  if (!target) return;
  const round=getRounds(target)[roundIndex]; const name=window.prompt('Название новой темы', `Тема ${getThemes(round).length + 1}`);
  if (!name?.trim()) return; const theme=el(target.doc,'theme',{name:name.trim()}); theme.append(el(target.doc,'questions')); first(round,'themes')!.append(theme); message='Тема добавлена'; render();
}

function renameTheme(roundIndex: number, themeIndex: number) {
  if (!target) return;
  const rounds=getRounds(target); const theme=getThemes(rounds[roundIndex])[themeIndex]; const name=window.prompt('Название темы',theme.getAttribute('name')||'');
  if (!name?.trim()) return;
  const labels=rounds.map((round,index)=>`${index+1}. ${round.getAttribute('name')||`Раунд ${index+1}`}`).join('\n');
  const picked=window.prompt(`В какой раунд поместить тему?\n${labels}`, String(roundIndex+1));
  const destination=Number(picked)-1;
  if (!Number.isInteger(destination) || !rounds[destination]) return;
  theme.setAttribute('name',name.trim());
  if (destination !== roundIndex) first(rounds[destination],'themes')!.append(theme);
  message=destination===roundIndex ? 'Название темы изменено' : 'Тема переименована и перенесена в другой раунд'; render();
}

function deleteRound(roundIndex: number) {
  if (!target) return;
  const round=getRounds(target)[roundIndex]; const questionCount=getThemes(round).reduce((total,theme)=>total+getQuestions(theme).length,0);
  if (!window.confirm(`Удалить раунд «${round.getAttribute('name') || ''}» вместе с ${questionCount} вопросами?`)) return;
  if (selected && round.contains(selected.element)) selected=null;
  round.remove(); message='Раунд удалён'; render();
}

function deleteTheme(roundIndex: number, themeIndex: number) {
  if (!target) return;
  const theme=getThemes(getRounds(target)[roundIndex])[themeIndex]; const questionCount=getQuestions(theme).length;
  if (!window.confirm(`Удалить тему «${theme.getAttribute('name') || ''}» вместе с ${questionCount} вопросами?`)) return;
  if (selected && theme.contains(selected.element)) selected=null;
  theme.remove(); message='Тема удалена'; render();
}

function addQuestion(roundIndex: number, themeIndex: number) {
  if (!target) return;
  const question=window.prompt('Текст вопроса'); if (question === null) return;
  const answer=window.prompt('Правильный ответ'); if (answer === null) return;
  const price=window.prompt('Цена вопроса', '100'); if (price === null || !/^\d+$/.test(price.trim())) return;
  const q=el(target.doc,'question',{price:price.trim(),type:'simple'}); const params=el(target.doc,'params'); const questionParam=el(target.doc,'param',{name:'question',type:'content'}); const item=el(target.doc,'item'); item.textContent=question; questionParam.append(item); params.append(questionParam); q.append(params); const right=el(target.doc,'right'); const answerNode=el(target.doc,'answer'); answerNode.textContent=answer; right.append(answerNode); q.append(right);
  const theme=getThemes(getRounds(target)[roundIndex])[themeIndex]; first(theme,'questions')!.append(q); sortThemeQuestions(theme); message='Вопрос добавлен'; render();
}

async function copyMedia(node: Element, from: Pack, to: Pack, cloned: Element) { const fromItems=[...node.getElementsByTagNameNS(NS,'item')].filter(i=>i.getAttribute('type') && i.getAttribute('type')!=='text'); const toItems=[...cloned.getElementsByTagNameNS(NS,'item')].filter(i=>i.getAttribute('type') && i.getAttribute('type')!=='text'); for(let i=0;i<fromItems.length;i++) { if(!fromItems[i].getAttribute('isRef')) continue; const original=text(fromItems[i]); const sourcePath=findFile(from,original); if(!sourcePath) continue; let destPath=sourcePath; const bytes=await from.zip.file(sourcePath)?.async('uint8array'); if(!bytes) continue; const existing=to.copied.get(destPath) || await to.zip.file(destPath)?.async('uint8array'); if(existing && !same(existing,bytes)) { const dot=destPath.lastIndexOf('.'); destPath=`${destPath.slice(0,dot)}_copy_${crypto.randomUUID().slice(0,8)}${destPath.slice(dot)}`; } if(!existing || !same(existing,bytes)) to.copied.set(destPath,bytes); toItems[i].textContent=destPath.split('/').pop()!; } }
function same(a: Uint8Array,b: Uint8Array) { return a.length===b.length && a.every((v,i)=>v===b[i]); }

function mediaKind(file: File) {
  if (file.type.startsWith('image/')) return ['image','Images'];
  if (file.type.startsWith('audio/')) return ['audio','Audio'];
  if (file.type.startsWith('video/')) return ['video','Video'];
  const extension=file.name.split('.').pop()?.toLowerCase();
  if (['jpg','jpeg','png','gif','webp','bmp'].includes(extension||'')) return ['image','Images'];
  if (['mp3','ogg','wav','m4a','flac'].includes(extension||'')) return ['audio','Audio'];
  return ['video','Video'];
}

async function addMedia(q: Element, paramName: string, files: FileList | null) {
  if (!target || !files?.length) return;
  const params=first(q,'params')!;
  let param=children(params,'param').find(x=>x.getAttribute('name')===paramName);
  if (!param) { param=el(target.doc,'param',{name:paramName,type:'content'}); params.append(param); }
  for (const file of files) {
    const [type,folder]=mediaKind(file); const bytes=new Uint8Array(await file.arrayBuffer());
    const bare=file.name.replace(/[\\/]/g,'_'); const dot=bare.lastIndexOf('.'); let suffix=0; let path=`${folder}/${bare}`;
    while (true) { const existing=target.copied.get(path) || await target.zip.file(path)?.async('uint8array'); if (!existing || same(existing,bytes)) break; suffix++; path=`${folder}/${dot>0?bare.slice(0,dot):bare}_${suffix}${dot>0?bare.slice(dot):''}`; }
    if (!target.copied.has(path)) target.copied.set(path,bytes);
    const item=el(target.doc,'item',{type,isRef:'True'}); item.textContent=path.slice(path.lastIndexOf('/')+1); param.append(item);
  }
}

function removeMedia(q: Element, paramName: string, index: number) {
  const params=first(q,'params')!; const items=children(params,'param').filter(x=>x.getAttribute('name')===paramName).flatMap(p=>[...p.children].filter(x=>local(x)==='item' && x.getAttribute('type') && x.getAttribute('type')!=='text')); items[index]?.remove();
}

function setTextParam(q: Element, name: string, value: string) {
  const params=first(q,'params')!; let param=children(params,'param').find(x=>x.getAttribute('name')===name);
  if (!param) { param=el(target!.doc,'param',{name}); params.append(param); }
  param.textContent=value;
}

function removeParam(q: Element, name: string) { children(first(q,'params')!, 'param').filter(p=>p.getAttribute('name')===name).forEach(p=>p.remove()); }

// Спец-параметры требуются только «котам» (secret/secretPublicPrice): selectionMode, theme и цена-заглушка numberSet 0.
// Остальные игровые типы (simple, noRisk, stake, stakeAll, forAll, auction) спец-параметров не имеют: цену и ставки
// игра вычисляет сама из номинала и счёта игроков (сверено с реальными пакетами и схемой SIQ).
function configureGameType(q: Element, type: string) {
  q.setAttribute('type',type);
  ['selectionMode','theme'].forEach(name=>removeParam(q,name));
  const priceParams=children(first(q,'params')!, 'param').filter(p=>p.getAttribute('name')==='price' && p.getAttribute('type')==='numberSet'); priceParams.forEach(p=>p.remove());
  if (type==='secret' || type==='secretPublicPrice') {
    setTextParam(q,'selectionMode',type==='secret'?'exceptCurrent':'any');
    const price=el(target!.doc,'param',{name:'price',type:'numberSet'}); price.append(el(target!.doc,'numberSet',{minimum:'0',maximum:'0',step:'0'})); first(q,'params')!.append(price);
    setTextParam(q,'theme','');
  }
}

function configureAnswerType(q: Element, type: string, deviation: string) {
  removeParam(q,'answerType'); removeParam(q,'answerDeviation');
  if (type!=='text') setTextParam(q,'answerType',type);
  if (type==='point') setTextParam(q,'answerDeviation',deviation || '0.05');
}

async function download() { if(!target) return; sortAllQuestions(target); const out=new JSZip(); for(const [name,file] of Object.entries(target.zip.files)) if(!file.dir && name!=='content.xml') out.file(name,await file.async('uint8array')); for(const [name,bytes] of target.copied) out.file(name,bytes); const files=el(target.doc,'files'); const old=first(target.doc.documentElement,'files'); if(old) old.replaceWith(files); else target.doc.documentElement.insertBefore(files,target.doc.documentElement.firstChild); for(const name of Object.keys(out.files).filter(n=>!out.files[n].dir && n!=='quality.marker')) { const bytes=await out.file(name)!.async('uint8array'); const digest=await crypto.subtle.digest('SHA-256',bytes.slice().buffer as ArrayBuffer); const hash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('').toUpperCase(); files.append(el(target.doc,'file',{name,hash})); } out.file('content.xml',new XMLSerializer().serializeToString(target.doc)); const blob=await out.generateAsync({type:'blob', compression:'DEFLATE', compressionOptions:{level:9}}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=(target.doc.documentElement.getAttribute('name')||'package').replace(/[\\/:*?"<>|]/g,'_')+'.siq'; a.click(); URL.revokeObjectURL(a.href); message='Пакет собран и скачан'; render(); }

function bind() {
 document.querySelector<HTMLInputElement>('#source-file')?.addEventListener('change',async e=>{try {source=await loadPack((e.target as HTMLInputElement).files![0]); message=(source.legacy?'Пак SIQ4 распознан и конвертирован в SIQ5. ':'')+'Отдающий пакет открыт'; render();}catch(err){message=String(err);render();}});
 document.querySelector<HTMLInputElement>('#target-file')?.addEventListener('change',async e=>{try {target=await loadPack((e.target as HTMLInputElement).files![0]); message=(target.legacy?'Пак SIQ4 распознан и конвертирован в SIQ5. ':'')+'Принимающий пакет открыт'; render();}catch(err){message=String(err);render();}});
 document.querySelector('#new-pack')?.addEventListener('click',()=>{target=newPack();message='Создан пакет с 3 раундами и 15 пустыми темами';render();}); document.querySelector('#download')?.addEventListener('click',download);
 document.querySelectorAll<HTMLButtonElement>('.question').forEach(b=>b.addEventListener('click',()=>{const p=b.dataset.side==='source'?source:target; if(!p)return; selected={pack:b.dataset.side as 'source'|'target',element:getQuestions(getThemes(getRounds(p)[+b.dataset.r!])[+b.dataset.t!])[+b.dataset.q!]};render();media();}));
 document.querySelector('#copy-question')?.addEventListener('click',copyQuestion); document.querySelector('#move-question')?.addEventListener('click',moveQuestion); document.querySelector<HTMLSelectElement>('#destination')?.addEventListener('change',e=>{lastDestination=(e.target as HTMLSelectElement).value;}); document.querySelector('#pack-name')?.addEventListener('input',e=>{target!.doc.documentElement.setAttribute('name',(e.target as HTMLInputElement).value);target!.name=(e.target as HTMLInputElement).value;});
 document.querySelector('#add-round')?.addEventListener('click',addRound); document.querySelectorAll<HTMLButtonElement>('.edit-round').forEach(b=>b.addEventListener('click',()=>renameRound(+b.dataset.r!))); document.querySelectorAll<HTMLButtonElement>('.delete-round').forEach(b=>b.addEventListener('click',()=>deleteRound(+b.dataset.r!))); document.querySelectorAll<HTMLButtonElement>('.add-theme').forEach(b=>b.addEventListener('click',()=>addTheme(+b.dataset.r!))); document.querySelectorAll<HTMLButtonElement>('.edit-theme').forEach(b=>b.addEventListener('click',()=>renameTheme(+b.dataset.r!,+b.dataset.t!))); document.querySelectorAll<HTMLButtonElement>('.delete-theme').forEach(b=>b.addEventListener('click',()=>deleteTheme(+b.dataset.r!,+b.dataset.t!))); document.querySelectorAll<HTMLButtonElement>('.add-question').forEach(b=>b.addEventListener('click',()=>addQuestion(+b.dataset.r!,+b.dataset.t!)));
 document.querySelectorAll<HTMLButtonElement>('.copy-theme').forEach(b=>b.addEventListener('click',()=>void copyTheme(+b.dataset.r!,+b.dataset.t!))); document.querySelectorAll<HTMLButtonElement>('.copy-round').forEach(b=>b.addEventListener('click',()=>void copyRound(+b.dataset.r!)));
 document.querySelector('#save-edit')?.addEventListener('click',async()=>{if(!selected||!target)return;const q=selected.element;const params=first(q,'params')!;let p=children(params,'param').find(x=>x.getAttribute('name')==='question');children(params,'param').filter(x=>x.getAttribute('name')==='question').slice(1).forEach(extra=>{[...extra.children].forEach(it=>p!.append(it));extra.remove();});let item=p && [...p.children].find(x=>local(x)==='item' && (!x.getAttribute('type') || x.getAttribute('type')==='text'));const editedQuestion=document.querySelector<HTMLTextAreaElement>('#edit-question')!;const hasText=editedQuestion.value.trim().length>0;if(!p&&hasText){p=el(target.doc,'param',{name:'question',type:'content'});params.insertBefore(p,params.firstChild);}if(p&&!item&&hasText){item=el(target.doc,'item');p.insertBefore(item,p.firstChild);}if(item){if(hasText)item.textContent=editedQuestion.value;else if([...p!.children].some(x=>local(x)==='item'&&x.getAttribute('type')&&x.getAttribute('type')!=='text'))item.remove();else item.textContent='';}const a=[...q.getElementsByTagNameNS(NS,'answer')][0];const editedAnswer=document.querySelector<HTMLInputElement>('#edit-answer')!;if(a)a.textContent=editedAnswer.value;q.setAttribute('price',(document.querySelector<HTMLInputElement>('#edit-price')!).value);configureGameType(q,(document.querySelector<HTMLSelectElement>('#edit-game-type')!).value);configureAnswerType(q,(document.querySelector<HTMLSelectElement>('#edit-answer-type')!).value,(document.querySelector<HTMLInputElement>('#edit-deviation')!).value);await addMedia(q,'question',document.querySelector<HTMLInputElement>('#question-media')?.files||null);await addMedia(q,'answer',document.querySelector<HTMLInputElement>('#answer-media')?.files||null);message='Изменения и вложения сохранены';render();});
 document.querySelector('#delete-question')?.addEventListener('click',()=>{if(!selected||!target||!window.confirm('Удалить этот вопрос из принимающего пакета?'))return;selected.element.remove();selected=null;message='Вопрос удалён';render();});
 document.querySelectorAll<HTMLButtonElement>('.remove-media').forEach(button=>button.addEventListener('click',()=>{if(!selected)return;removeMedia(selected.element,button.dataset.param!,+button.dataset.index!);message='Вложение удалено из вопроса';render();}));
}
render();
