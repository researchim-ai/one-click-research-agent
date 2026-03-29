# One-Click Research Agent

Английская версия: `README_EN.md`

`one-click-research-agent` — это локальный исследовательский агент на open-source моделях, упакованный как Electron-приложение.

Проект вырос из базы `one-click-coding-agent`, но теперь переориентируется в приватное исследовательское рабочее пространство, которое умеет анализировать файлы, репозитории, статьи, запускать инструменты и синтезировать выводы без отправки пользовательских данных во внешние AI API.

## Основная идея

Цель проекта — не сделать "еще один чат с LLM".

Цель — построить локальный research runtime, который умеет:

- исследовать темы и источники;
- анализировать локальные файлы и репозитории;
- запускать команды и собирать артефакты;
- сравнивать выводы из разных источников;
- поддерживать доменные пресеты, например для papers или анализа open-source приложений;
- хранить данные на машине пользователя.

## Продуктовое направление

Приложение строится вокруг трех принципов:

- `Local-first`: файлы, заметки, результаты и research-артефакты остаются у пользователя.
- `Open-source-only`: агент рассчитан на работу с open-source моделями через `llama.cpp`, а не на зависимость от проприетарных API.
- `Agentic workflows`: система умеет читать, запускать, проверять и синтезировать, а не только генерировать текст.

## Текущее состояние

В проекте уже есть:

- desktop shell на Electron
- renderer на React
- локальный setup модели и сервера через `llama.cpp`
- agent runtime с инструментами
- дерево файлов, редактор, терминал, чат и сессии
- настраиваемые параметры агента и промпты
- выбор пресетов для специализированных режимов

Сейчас доступны такие research-пресеты:

- `Universal Research`
- `Arxiv Papers`
- `Open Source App Analysis`
- `Biology Research`
- `Math Research`
- `Finance Research`
- `Paper Reproduction`

## Что уже работает

Уже реализовано:

- дефолтный режим `Universal Research`
- выбор research-пресетов в панели настроек
- research-oriented системные промпты вместо старых coding-only инструкций
- поиск arXiv через `search_arxiv`
- загрузка arXiv HTML через `download_arxiv_html`
- загрузка arXiv PDF через `download_arxiv_pdf`
- автообновление левой панели после file tools, команд и custom tools агента

Текущий рекомендуемый flow для arXiv:

1. найти статьи
2. предпочитать arXiv HTML, если он доступен
3. использовать PDF как fallback

## Разработка

Установка зависимостей:

```bash
npm install
```

Запуск в режиме разработки:

```bash
npm run dev
```

Сборка приложения:

```bash
npm run build
```

Пакет для Linux:

```bash
npm run package:linux
```

## Первый запуск

Типичный сценарий первого запуска:

1. Запусти приложение через `npm run dev`
2. Дай setup wizard подготовить локальную модель и сервер
3. Открой рабочую директорию
4. Открой `Settings -> Agent`
5. Оставь `Universal Research` или выбери, например, `Arxiv Papers`
6. Начни работу через чат справа

## Примеры запросов

### Universal Research

- `Изучи проект и опиши архитектуру`
- `Собери краткий research brief по теме browser agents`
- `Сравни несколько подходов и выдели риски`

### Arxiv Papers

- `Найди лучшие arXiv papers по reinforcement learning`
- `Сравни 5 papers по теме small language models for agents`
- `Скачай HTML версии лучших статей и выдели основные claims`

### Open Source App Analysis

- `Запусти проект и опиши как он устроен`
- `Разбери точки расширения этого приложения`
- `Сравни поведение приложения и документацию`

## Заметки по arXiv

Сейчас проект использует arXiv по модели `HTML-first, PDF-fallback`.

Почему так:

- HTML проще парсить и анализировать, чем PDF
- HTML лучше подходит для extraction по секциям
- не у каждой статьи есть хорошая HTML-версия
- PDF остается надежным запасным вариантом

Уже реализованные arXiv-инструменты:

- `search_arxiv`
- `download_arxiv_html`
- `download_arxiv_pdf`

## Обзор архитектуры

Структура на верхнем уровне:

- `electron/`: main process, agent runtime, tools, интеграция с моделью и сервером
- `src/`: renderer UI на React
- `research-presets.ts`: реестр пресетов и prompt add-ons
- `dist/`: собранный renderer
- `dist-electron/`: собранные Electron entrypoints

Концептуально приложение устроено так:

- общий runtime
- дефолтный универсальный агент
- optional domain presets
- toolpacks и воспроизводимые workflow

## Приватность

Проект специально развивается вокруг privacy-sensitive сценариев.

Это означает:

- локальные файлы являются основным источником истины
- research-артефакты остаются локальными, пока пользователь сам их не экспортирует
- приложение строится вокруг локального запуска open-source моделей
- в core design нет зависимости от ChatGPT-only подхода

## Ближайший roadmap

Планы на ближайшие шаги:

- более богатый arXiv workflow с metadata-артефактами и сохранением paper-сессий
- HTML-first paper ingestion и structured extraction
- лучшее хранение research-артефактов внутри `.research/`
- более сильные preset-specific toolpacks
- улучшенный flow `paper -> code -> reproduction`

## Статус

Проект находится в активной разработке, и README будет меняться вместе с развитием research runtime.