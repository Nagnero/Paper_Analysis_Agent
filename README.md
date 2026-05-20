# PAA (Paper Analysis Agent) · v0.3.0

영어 논문 PDF 한 편을 입력하면 4개의 LLM 에이전트(orchestrator → analyst → verifier → writer)가 협업해 **각 주장(claim)에 원문 근거가 매핑된 한국어 분석 리포트**를 생성하는 데스크탑 앱입니다.

본 도구는 어떤 LLM API 키도 사용하지 않습니다. 사용자의 **Claude Pro/Max 구독**에 연결된 `claude` Code CLI, 또는 **ChatGPT 구독**에 연결된 `codex` CLI 를 로컬에서 subprocess 로 호출해 동작합니다 (역할별로 선택 가능). 토큰당 추가 과금이 없고, 분석한 PDF 는 외부 서버에 업로드되지 않습니다.

## 한 줄 요약

영어 논문 PDF → claim 별 원문 근거가 검증된 한국어 11-섹션 리포트.

## 시스템 구성도

PAA 는 사용자의 로컬 CLI(`claude` / `codex`)를 통해 LLM 을 호출합니다. 따라서 **앱 실행 전에 백엔드 CLI 로그인이 한 번 필요**하고, 그 다음부터는 파이프라인이 그 자격증명을 그대로 빌려 씁니다.

```
[사전 1회] 백엔드 CLI 로그인
─────────────────────────────────────────────────────────────
   사용자 ──▶  claude  (https://claude.com/code)
                └─ Claude Pro / Max 계정 OAuth
        ──▶  codex   (선택, https://github.com/openai/codex)
                └─ ChatGPT 구독 또는 API 키 로그인

                              │
                              ▼
[앱 실행 시] 가용성 프로브 — core/authStatus.js
─────────────────────────────────────────────────────────────
  claude auth status --json   ─┐
  codex login status          ─┤── 가용한 백엔드 목록
                                │   설정 화면에 표시
                              │
                              ▼
[분석 트리거] PDF 첨부 + (선택) 강조사항 입력
─────────────────────────────────────────────────────────────
  utils/parsePdf → text

                              │
                              ▼
[파이프라인] pipeline.js — 4단계 + 1 보조
─────────────────────────────────────────────────────────────
  ① orchestrator   emphasis 해석 → directive
       │
  ② analyst        claim + reproducibility 추출
       │
  ③ verifier       BM25 retrieval + claim 별 근거 확인
       │           라벨: supported / partially_supported /
       │                 unsupported / contradicted
       ├ (병렬) focusedAudit  ad-hoc 감사 작업
       │
  ④ writer         한국어 11-섹션 Markdown 리포트

  각 단계는 core/llmConfig 에 따라
  → core/claudeClient  (spawn 'claude -p --output-format json')
   또는
  → core/codexCli      (spawn 'codex exec --skip-git-repo-check')
  로 라우팅

                              │
                              ▼
[결과] 한국어 11-섹션 리포트 + claim 별 검증 표 + 단계별 메트릭
```

## 주요 기능

- **4-에이전트 LLM 파이프라인** — orchestrator(emphasis 해석) → analyst(claim 추출) → verifier(BM25 + LLM 근거 확인) → writer(한국어 11-섹션 리포트)
- **Claim 별 원문 근거 매핑** — 모든 주장에 `supported / partially_supported / unsupported / contradicted` 라벨 + 원문 발췌 + 섹션·페이지 인용
- **청크 분할 + BM25 retrieval** — 긴 논문도 claim 별 관련 구간만 LLM 에 전달
- **프롬프트 런타임 편집** — `prompts/*.md` 4 종을 앱 안에서 바로 수정 (`⚙ 설정`)
- **분석 후 후속 채팅** — 분석 끝난 세션에 논문·리포트 컨텍스트 기반으로 자유 질문
- **로컬 only** — PDF / 자격증명 / 분석 결과 모두 사용자 PC 에만. 외부 업로드 0.

## 요구사항

최소 백엔드 CLI **하나 이상**이 설치 + 로그인된 상태여야 합니다 (둘 다 있으면 역할별로 선택 가능).

| 항목 | 버전 / 설명 |
|---|---|
| **OS** | Windows 10/11 (검증), macOS / Linux (코드 호환, 미검증) |
| **Claude Code CLI** (백엔드 1) | https://claude.com/code — 사전 설치 + `claude` 실행해 Claude Pro/Max 계정 로그인 |
| **Codex CLI** (백엔드 2, 선택) | https://github.com/openai/codex — 사전 설치 + `codex login` 으로 ChatGPT 구독 또는 API 키 인증. **v0.2.1+** 부터 지원 |
| **Node.js** | 소스에서 직접 실행할 경우만 필요. **24.15.0 (LTS) 권장** · `>=20 <26` 범위 지원. Node 26+ 에서 electron post-install 다운로드 실패 케이스 보고됨 |

> PAA 는 어떤 LLM API 키도 저장하거나 요구하지 않습니다. 인증은 전적으로 사용자의 `claude` / `codex` CLI 가 관리합니다.

## Quick start

### 옵션 A — 사전 빌드된 exe 다운로드 (추천)

1. **백엔드 CLI 로그인** — `claude` 또는 `codex` 둘 중 하나(또는 둘 다) 설치하고 한 번 로그인.
2. [**Releases**](https://github.com/evejaeyong/Paper_Analysis_Agent/releases/latest) 페이지에서 본인 OS / 아키텍처에 맞는 파일 다운로드:
   - **`PAA-x.y.z-setup.exe`** (Windows) — 설치형. 시작 메뉴 / 바탕화면 단축키 생성.
   - **`PAA-x.y.z.exe`** (Windows) — 포터블. 더블클릭만으로 실행 (설치 X, 임시 폴더에 자동 압축 해제).
   - **`PAA-x.y.z-arm64.dmg`** (macOS Apple Silicon — M1/M2/M3/M4)
   - **`PAA-x.y.z-x64.dmg`** (macOS Intel)
3. 실행하면 채팅형 UI 가 뜹니다. CLI 가 없거나 미로그인이면 안내 화면이 뜨니, 거기 링크 따라 설치/로그인 후 **다시 시도** 클릭.

> 첫 실행 시 SmartScreen "Windows 가 PC 를 보호했습니다" 경고가 뜰 수 있어요 — 코드사이닝 미적용 빌드라 정상 경고입니다. **자세히 → 실행** 으로 진행.

### 옵션 B — 소스에서 실행 (개발자 / 코드 수정)

```bash
git clone https://github.com/evejaeyong/Paper_Analysis_Agent.git paa
cd paa
npm install
npm start
```

`npm start` 가 다음을 순서로 수행합니다:
1. `claude` / `codex` CLI 가용성 프로브 (`core/authStatus`)
2. 임의 포트에 로컬 HTTP/SSE 서버 부트
3. BrowserWindow 가 그 페이지를 로드 → 채팅형 UI 표시

## 사용 흐름

1. PDF 첨부 (📎 또는 드래그&드롭)
2. (선택) 입력창에 강조 사항 입력 — 예: "Method 의 가정이 견고한지 회의적으로 봐줘" → orchestrator 가 추가 감사 작업 생성
3. ↑ 전송 → 4-단계 진행상황 SSE 로 스트림
4. 완료 후 11-섹션 리포트 + 통계 패널 (단계별 토큰/소요시간, claim 별 검증 결과 표)
5. 같은 세션에서 후속 질문 (페르소나 선택 가능)

## 트러블슈팅

### `Error: ENOENT ... node_modules\electron\path.txt`

`npm install` 시 electron 바이너리(약 100MB) post-install 다운로드가 실패한 상태. **Node 24 LTS 사용 권장** — Node 26 이상에서 silent fail 사례 보고됨.

```powershell
# 1) node -v 로 24.x 인지 확인 (아니면 nvm 등으로 24.15.0 설치)
# 2) electron 모듈만 재설치
Remove-Item -Recurse -Force node_modules\electron -ErrorAction SilentlyContinue
npm install electron@^42.1.0
# 3) 다운로드 끝났는지 확인 (True 떠야 함)
node -e "console.log(require('fs').existsSync('node_modules/electron/path.txt'))"
npm start
```

직접 진단하려면 `node node_modules\electron\install.js` 로 post-install 을 강제 실행 — 네트워크/프록시/권한 에러가 콘솔에 그대로 나옵니다.

### `claude.cmd` is not recognized / 안내 화면이 떠요

`claude` CLI 가 PATH 에 없는 상태. https://claude.com/code 에서 설치 후 새 터미널에서 `claude --version` 확인. 인증은 처음 `claude` 실행 시 자동 OAuth.

### SmartScreen "Windows 가 PC 를 보호했습니다" 경고

코드사이닝 인증서를 적용하지 않은 릴리즈입니다. **자세히 → 실행** 으로 진행하시면 됩니다.

### `codex exit 1: Not inside a trusted directory`

**v0.2.1 미만에서 발생하던 이슈** — 설치본의 CWD 가 git repo 가 아니라 Codex CLI 가 거부하던 케이스. v0.2.1 부터 호출별 임시 폴더로 격리해 해결됐습니다. 최신 릴리즈로 업데이트하세요.

### 분석 도중 응답이 끊겨요

큰 논문 + 많은 claim 조합에서 LLM 응답이 끊길 수 있습니다. `agents/verifier.js` 의 `BATCH_SIZE` 를 낮춰(예: 5 → 3) 호출 단위를 작게 쪼개면 개선됩니다.

## 비용 & 프라이버시

- **비용 모델**: Claude Pro/Max 또는 ChatGPT 구독 월정액 그대로 (사용하는 백엔드에 따라). 페이퍼 당 추가 과금 없음. Anthropic / OpenAI API 키 미사용.
- **프라이버시**:
  - PDF 는 OS 임시 디렉토리(`os.tmpdir()`)에 잠시만 저장되고 분석 직후 삭제.
  - 분석 결과(리포트, 메트릭, claim 검증)는 앱 메모리에만 보관 — 세션 종료 시 사라짐.
  - 자격증명은 `claude` / `codex` CLI 가 OS 자격증명 저장소에 보관. 본 앱이 직접 다루지 않음.
  - 외부 네트워크 호출은 오직 사용자가 선택한 CLI(`claude` → Anthropic, `codex` → OpenAI) 가 자체적으로 백엔드와 통신하는 것뿐.

## 한계 / 알려진 이슈

- **수식 / 그림 / 표** — `pdf-parse` 가 텍스트만 추출. 수식과 figure caption 분리, 표 셀 구조 보존 안 됨.
- **다중 논문 비교 없음** — 한 편씩만. 여러 편 종합 리뷰 미지원.
- **References 자동 파싱 없음** — 참고문헌 추출 / cross-ref / 인용 그래프 미지원.
- **Persistent library 없음** — 분석 결과 저장 / 검색 / 태그 안 됨. 일회성.
- **macOS / Linux 빌드** — 코드는 호환되지만 실제 패키징은 검증 안 함.
- **수식 OCR / figure 분석 / Semantic Scholar 메타데이터 연동** — 모두 향후 작업.

## 디렉토리 구조

```
paa/
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
