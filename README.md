# Veridict · v0.1.0

영어 논문 PDF 한 편을 입력하면 4개의 LLM 에이전트(orchestrator → analyst → verifier → writer)가 협업해 **각 주장(claim)에 원문 근거가 매핑된 한국어 분석 리포트**를 생성하는 Electron 데스크탑 앱입니다.

본 도구는 Anthropic API 키를 사용하지 않습니다. 사용자의 **Claude Pro/Max 구독**에 연결된 `claude` Code CLI 를 로컬에서 subprocess 로 호출해 동작합니다. 토큰당 과금이 없고, 분석한 PDF 는 외부 서버에 업로드되지 않습니다.

## 한 줄 요약

영어 논문 PDF → claim 별 원문 근거가 검증된 한국어 11-섹션 리포트.

## 시스템 구성도

```
┌─────────────────────────────────────────────────────────────┐
│                  Electron (electron-main.mjs)               │
│  - BrowserWindow → http://127.0.0.1:<port> 로드             │
│  - 시작 시 claude CLI 가용성 프로브                          │
└──────────────────────────┬──────────────────────────────────┘
                           │ in-process
                           ▼
┌─────────────────────────────────────────────────────────────┐
│         HTTP / SSE server (server.js)                       │
│  POST /analyze   ─ PDF 업로드 → 분석 스트림                  │
│  POST /chat      ─ 분석 후 후속 질의응답                     │
│  GET/PUT /api/prompts  ─ 프롬프트 런타임 편집                │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Pipeline (pipeline.js)                         │
│                                                             │
│  utils/parsePdf  →  text                                    │
│        │                                                    │
│        ▼                                                    │
│  ┌─ agents/orchestrator   (emphasis 해석 → directive)       │
│  ├─ agents/analyst        (claim + reproducibility 추출)    │
│  ├─ agents/verifier       (BM25 retrieval + claim 별 검증)  │
│  ├─ agents/focusedAudit   (ad-hoc 감사 작업, 병렬)          │
│  └─ agents/writer         (한국어 11-섹션 Markdown 작성)    │
│                                                             │
│  검증 상태: supported / partially_supported /               │
│             unsupported / contradicted                      │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│   core/claudeClient  ──  spawn('claude -p --output-format   │
│                                  json < prompt.txt')        │
│              ▼                                              │
│        사용자의 Claude Code CLI (본인 구독)                  │
└─────────────────────────────────────────────────────────────┘
```

## 주요 기능

- **4-에이전트 LLM 파이프라인** — orchestrator(emphasis 해석) → analyst(claim 추출) → verifier(BM25 + LLM 근거 확인) → writer(한국어 11-섹션 리포트)
- **Claim 별 원문 근거 매핑** — 모든 주장에 `supported / partially_supported / unsupported / contradicted` 라벨 + 원문 발췌 + 섹션·페이지 인용
- **청크 분할 + BM25 retrieval** — 긴 논문도 claim 별 관련 구간만 LLM 에 전달
- **프롬프트 런타임 편집** — `prompts/*.md` 4 종을 앱 안에서 바로 수정 (`⚙ 설정`)
- **페르소나 후속 채팅** — 분석 끝난 세션에 "중립" / "적대적 리뷰어" 모드로 질문
- **로컬 only** — PDF / 자격증명 / 분석 결과 모두 사용자 PC 에만. 외부 업로드 0.

## 요구사항

| 항목 | 버전 / 설명 |
|---|---|
| **OS** | Windows 10/11 (검증), macOS / Linux (코드 호환, 미검증) |
| **Node.js** | 20 이상 |
| **Claude Code CLI** | https://claude.com/code — 사전 설치 + `claude` 한 번 실행해 본인 계정 로그인 필요 |
| **구독** | Claude Pro 또는 Max (사용자 본인 계정) |

> Veridict 는 어떤 API 키도 저장하거나 요구하지 않습니다. 인증은 전적으로 사용자의 `claude` CLI 가 관리합니다.

## Quick start

### 옵션 A — 소스에서 실행 (가장 빠름)

```bash
git clone https://github.com/evejaeyong/Paper_Analysis_Agent.git veridict
cd veridict
npm install
npm start              # Electron 데스크탑 앱 가동
```

`npm start` 가 다음을 순서로 수행합니다:
1. `claude --version` 으로 CLI 가용성 확인
2. 임의 포트에 로컬 HTTP/SSE 서버 부트
3. BrowserWindow 가 그 페이지를 로드 → 채팅형 UI 표시

CLI 가 없거나 미로그인이면 안내 화면이 뜹니다. 거기서 `claude.com/code` 링크 → 설치 → 터미널에서 `claude` 한 번 실행 → 본인 계정 로그인 → 앱에서 **다시 시도** 클릭.

### 옵션 B — Windows .exe 인스톨러 직접 빌드

```powershell
# Windows Developer Mode 켜야 함 (Settings → Privacy & Security → For developers)
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npm run dist:win
# → dist\Veridict Setup 0.1.0.exe (약 106 MB)
```

생성된 인스톨러는 다른 PC 로 배포 가능. 받는 사람도 **Claude Code CLI 사전 설치 + 본인 로그인** 은 필요합니다.

### 옵션 C — CLI 모드 (앱 없이 한 편 분석)

```bash
node pipeline.js path/to/paper.pdf
# → paper.pdf 와 같은 폴더에 report.md 생성
```

서버/UI 없이 한 편의 PDF 를 분석해 마크다운 리포트만 떨어뜨리고 끝납니다. 배치 스크립트나 CI 에 끼우기 좋습니다.

## 사용 흐름

1. PDF 첨부 (📎 또는 드래그&드롭)
2. (선택) 입력창에 강조 사항 입력 — 예: "Method 의 가정이 견고한지 회의적으로 봐줘" → orchestrator 가 추가 감사 작업 생성
3. ↑ 전송 → 4-단계 진행상황 SSE 로 스트림
4. 완료 후 11-섹션 리포트 + 통계 패널 (단계별 토큰/소요시간, claim 별 검증 결과 표)
5. 같은 세션에서 후속 질문 (페르소나 선택 가능)

## 트러블슈팅

### `claude.cmd` is not recognized / 안내 화면이 떠요

`claude` CLI 가 PATH 에 없는 상태. https://claude.com/code 에서 설치 후 새 터미널에서 `claude --version` 확인. 인증은 처음 `claude` 실행 시 자동 OAuth.

### Windows 빌드 실패 — `Cannot create symbolic link`

`electron-builder` 가 `winCodeSign` 패키지 안의 macOS 파일을 추출하면서 심볼릭 링크를 만들려고 합니다. Windows 는 일반 사용자가 symlink 생성 불가.

**해결**: Windows **Developer Mode** ON (Settings → Privacy & Security → For developers → Developer Mode). 토글 후 즉시 적용, 재부팅 불필요. 캐시(`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign`) 비우고 재빌드.

### SmartScreen "Windows 가 PC 를 보호했습니다" 경고

코드사이닝 인증서를 적용하지 않은 첫 릴리즈입니다. **자세히 → 실행** 으로 진행하시면 됩니다.

### 분석 도중 응답이 끊겨요

큰 논문 + 많은 claim 조합에서 LLM 응답이 끊길 수 있습니다. `agents/verifier.js` 의 `BATCH_SIZE` 를 낮춰(예: 5 → 3) 호출 단위를 작게 쪼개면 개선됩니다.

## 비용 & 프라이버시

- **비용 모델**: Claude Pro/Max 월정액 그대로. 페이퍼 당 추가 과금 없음. Anthropic API 키 미사용.
- **프라이버시**:
  - PDF 는 OS 임시 디렉토리(`os.tmpdir()`)에 잠시만 저장되고 분석 직후 삭제.
  - 분석 결과(리포트, 메트릭, claim 검증)는 Electron 메모리에만 보관 — 세션 종료 시 사라짐.
  - 자격증명은 `claude` CLI 가 OS 자격증명 저장소에 보관. 본 앱이 직접 다루지 않음.
  - 외부 네트워크 호출은 오직 `claude` CLI 가 Anthropic 백엔드로 보내는 것뿐.

## 한계 / 알려진 이슈

- **수식 / 그림 / 표** — `pdf-parse` 가 텍스트만 추출. 수식과 figure caption 분리, 표 셀 구조 보존 안 됨.
- **다중 논문 비교 없음** — 한 편씩만. 여러 편 종합 리뷰 미지원.
- **References 자동 파싱 없음** — 참고문헌 추출 / cross-ref / 인용 그래프 미지원.
- **Persistent library 없음** — 분석 결과 저장 / 검색 / 태그 안 됨. 일회성.
- **macOS / Linux 빌드** — 코드는 호환되지만 실제 패키징은 검증 안 함.
- **수식 OCR / figure 분석 / Semantic Scholar 메타데이터 연동** — 모두 향후 작업.

## 디렉토리 구조

```
veridict/
├── electron-main.mjs    # Electron 진입점 + claude CLI 프로브
├── server.js            # HTTP / SSE 서버
├── pipeline.js          # 4-단계 파이프라인 오케스트레이션
├── agents/              # LLM 에이전트 5종
├── core/                # LLM 클라이언트, 프롬프트 스토어
├── utils/               # parsePdf, chunker, bm25 (LLM-free)
├── prompts/             # 에이전트 프롬프트 템플릿 (.md)
├── public/              # 프론트엔드 (HTML/CSS/JS)
└── package.json         # electron-builder 설정 포함
```

## 라이선스

MIT License. 자세한 내용은 [LICENSE](./LICENSE) 참고.
