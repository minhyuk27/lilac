# Lilac: High-Performance Daily Planner & Calendar Plugin for Obsidian

Lilac은 옵시디언(Obsidian) 환경에서 일정, 할 일(Todo), 반복 루틴 및 스티키 노트를 통합 관리할 수 있도록 설계된 **반응형 캘린더 & 올인원 데일리 플래너 플러그인**입니다.

---

## 1. 프로젝트 개요 (Overview)

- **목적**: 마크다운 기반의 지식 관리 도구인 옵시디언 내에서 외부 서드파티 캘린더 없이도 유려한 UI와 초고속 성능으로 개인 일정과 프로젝트 태스크를 관리
- **대상 플랫폼**: Obsidian Desktop (Windows / macOS / Linux) 및 Obsidian Mobile (Android / iOS / Tablet)
- **개발 형태**: 1인 단독 설계 및 프론트엔드/엔진 개발 (기여도 100%)
- **핵심 특징**:
  - **반응형 3단 UI**: 오른쪽 사이드바 미니 패널, 전체 화면 몰입형 캘린더 뷰, 모바일 최적화 스와이프 인터페이스
  - **SQLite WASM 기반 로컬 인덱싱**: 수천 개의 일정/태스크를 마크다운 파일 파싱 지연 없이 수 밀리초 내에 즉시 조회
  - **Daily Note 양방향 동기화**: 플러그인에서 작성한 일정이 기존 옵시디언 데일리 노트와 실시간 양방향 연동
  - **정교한 시간 관리 도구**: 시작일/종료일 기간 밴드, 타임블록, 반복 루틴, 우선순위 색상 칩, 스티키 메모

---

## 2. 시스템 아키텍처 (Architecture)

```
[Obsidian Vault Markdown Files] ◄─── (Bidirectional Sync) ───┐
                │                                            │
                ▼                                            ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Lilac Plugin Core Engine                        │
│                                                                        │
│   [File System Watcher] ──► [Markdown Metadata Parser]                 │
│                                      │                                 │
│                                      ▼                                 │
│                        [SQLite WASM Local Index]                       │
│                                      │                                 │
│         ┌────────────────────────────┼────────────────────────────┐    │
│         ▼                            ▼                            ▼    │
│  [Calendar View]             [Sidebar Panel]            [Modal Editors]│
│  - Month / Week Grid         - Mini Calendar            - Date / Time  │
│  - Period Bands & Chips      - Today's Agenda           - Repeat Logic │
│  - Filter / Category         - Quick Checkbox           - Color Picker │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 핵심 기술 스택 (Tech Stack)

| 영역 | 기술 스택 | 설명 |
|---|---|---|
| **Language** | TypeScript (ES2022) | 엄격한 타입 안정성 및 모듈형 설계 (`tsc` 컴파일 무결) |
| **Framework & API** | Obsidian Plugin API | 에디터, 워크스페이스, 리본, 사이드바 DOM 연동 |
| **Local Database** | SQLite (WASM / `sql-wasm.wasm`) | 브라우저/모바일 네이티브 고속 인덱싱 |
| **Styling & UI** | CSS3, Flexbox/Grid, CSS Custom Properties | 옵시디언 테마(Light/Dark) 완전 동기화 및 반응형 레이아웃 |
| **Build & Bundler** | ESBuild | 수 밀리초 단위 초고속 프로덕션 번들링 |

---

## 4. 핵심 기능 상세 (Key Features)

1. **사이드바 통합 미니 패널**:
   - 백링크 패널 위치에 도구 모음, 미니 달력, 오늘/특정일의 태스크 목록을 일체형으로 배치하여 작업 흐름을 방해하지 않고 일정 확인
2. **반복 루틴 시스템 (Recurring Rules)**:
   - 매일, 주간 특정 요일 반복, 월간 특정 일자 반복 등 정밀한 반복 주기 계산 엔진 내장
   - 특정 회차만 변경하거나 건너뛰는 예외(Overrides) 처리 지원
3. **모바일 퍼스트 UX**:
   - 모바일 제스처와 터치 인터페이스를 고려한 반응형 액션 시트 및 스와이프 칩 컴포넌트

---

## 5. 빌드 및 배포 방법 (Development & Build)

```bash
# 의존성 설치
npm install

# 타입 검사 및 린트
npx tsc --noEmit --skipLibCheck

# 개발 모드 (소스 변경 감지 및 자동 빌드)
npm run dev

# 프로덕션 번들 빌드
npm run build
```

빌드 산출물(`main.js`, `manifest.json`, `styles.css`)은 옵시디언 볼트의 `.obsidian/plugins/lilac/` 경로에 자동 배포됩니다.

---

## 6. 라이선스 (License)

본 프로젝트는 [MIT License](LICENSE)를 따릅니다.
