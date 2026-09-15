# Сторонние компоненты и лицензии

Проект распространяется под лицензией MIT (см. `LICENSE`). Ниже перечислены
сторонние компоненты, которые используются в проекте или попадают в собранный
файл `dist/assets/index-*.js`.

## Зависимости, попадающие в сборку (runtime)

В минифицированный бандл включается только библиотека `jszip` и её зависимости.

| Пакет | Версия | Лицензия | Copyright |
|---|---|---|---|
| [jszip](https://github.com/Stuk/jszip) | 3.10.2 | MIT *(двойная: MIT OR GPL-3.0-or-later, используется ветка MIT)* | Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso |
| [pako](https://github.com/nodeca/pako) | 1.0.11 | MIT AND Zlib *(двойная: нужно соблюсти обе)* | Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn |
| [lie](https://github.com/calvinmetcalf/lie) | 3.3.0 | MIT | Copyright (c) 2014-2018 Calvin Metcalf, Jordan Harband |
| [setimmediate](https://github.com/YuzuJS/setImmediate) | 1.0.5 | MIT | Copyright (c) 2012 Barnesandnoble.com, llc, Donavon West, and Domenic Denicola |
| [immediate](https://github.com/calvinmetcalf/immediate) | 3.0.6 | MIT | Copyright (c) 2012 Barnesandnoble.com, llc, Donavon West, Domenic Denicola, Brian Cavalier |
| [readable-stream](https://github.com/nodejs/readable-stream) | 2.3.8 | MIT | Copyright Node.js contributors |
| [string_decoder](https://github.com/nodejs/string_decoder) | 1.1.1 | MIT | Copyright Node.js contributors |
| [core-util-is](https://github.com/isaacs/core-util-is) | 1.0.3 | MIT | Copyright Node.js contributors |
| [inherits](https://github.com/isaacs/inherits) | 2.0.4 | ISC | Copyright (c) Isaac Z. Schlueter |
| [isarray](https://github.com/juliangruber/isarray) | 1.0.0 | MIT | — |
| [safe-buffer](https://github.com/feross/safe-buffer) | 5.1.2 | MIT | Copyright (c) Feross Aboukhadijeh |
| [util-deprecate](https://github.com/Node.js/util-deprecate) | 1.0.2 | MIT | Copyright (c) 2014 Nathan Rajlich <nathan@tootallnate.net> |
| [process-nextick-args](https://github.com/calvinmetcalf/process-nextick-args) | 2.0.1 | MIT | Copyright (c) 2015 Calvin Metcalf |

Тексты лицензий MIT/ISC/Zlib разрешают использование, изменение и распространение
при условии сохранения уведомления об авторских правах и текста лицензии — данный
файл играет роль такого уведомления при распространении собранного `dist`.
Полные тексты лицензий лежат в `node_modules/<пакет>/LICENSE*` после `npm install`.

## Инструменты сборки (в сборку не попадают)

| Пакет | Версия | Лицензия |
|---|---|---|
| [typescript](https://github.com/microsoft/TypeScript) | 5.9.x | Apache-2.0 |
| [vite](https://github.com/vitejs/vite) | 6.4.x | MIT |
| [esbuild](https://github.com/evanw/esbuild) | 0.25.x | MIT |
| [rollup](https://github.com/rollup/rollup) | 4.63.x | MIT |
| [postcss](https://github.com/postcss/postcss) | 8.5.x | MIT |
| [source-map-js](https://github.com/7ph/source-map-js) | 1.2.x | BSD-3-Clause |

Полный список (65 dev-пакетов) — в `package-lock.json`.

## Python-утилиты

| Компонент | Лицензия | Примечание |
|---|---|---|
| `export_siq_questions.py` | — | только стандартная библиотека Python |
| `compress_siq.py` | — | стандартная библиотека + [Pillow](https://python-pillow.org/) (лицензия MIT-CMU) для lossless-пересборки PNG |
| [FFmpeg](https://ffmpeg.org/) | LGPL-2.1+ / GPL-2.0+ (зависит от сборки) | **не входит** в проект; вызывается как внешняя программа только в режиме `--transcode`. FFmpeg под GPL не заражает проект, т.к. не линкуется, но при распространении сборок ffmpeg нужно соблюдать его лицензию |

## Формат SIQ (SIGame)

Формат пакетов `.siq` (SIQ4 `ygpackage3.0`, SIQ5 `siq_5`) и продукты SIGame/SIQuester
созданы [Владимиром Хилем](https://github.com/VladimirKhil); репозиторий
[VladimirKhil/SI](https://github.com/VladimirKhil/SI) лицензирован под **MIT**.
В проекте используется только публичное описание формата (имена атрибутов, типов и
пространств имён) — код SIGame не копировался, XSD-схема в репозиторий не входит.

## Содержимое пакетов

Папки `siq/`, `notload/`, `compress/` с самими пакетами и медиафайлами (музыка,
видеоклипы, изображения) в репозиторий **не попадают** (см. `.gitignore`) и под
лицензию MIT не подпадают: права на этот контент принадлежат его авторам.
