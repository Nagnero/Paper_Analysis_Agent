// pipeline.js
// 사용법: node pipeline.js <pdfPath>
// PDF를 분석해 한국어 리포트 report.md를 PDF와 같은 폴더에 생성.
// 파이프라인: 분석가 → 검증가 → 작가. emphasis 있으면 오케스트레이터가 directive 생성 + ad-hoc 감사 추가.
import { parsePdf } from './utils/parsePdf.js';
import { run as runAnalyst } from './agents/analyst.js';
import { run as runVerifier } from './agents/verifier.js';
import { run as runWriter } from './agents/writer.js';
import { run as runOrchestrator, EMPTY_DIRECTIVE } from './agents/orchestrator.js';
import { run as runFocusedAudit } from './agents/focusedAudit.js';
import { getCurrent as getPrompts } from './core/promptStore.js';
import { getConfig as getLlmConfig } from './core/llmConfig.js';
import * as library from './core/library.js';
import * as fileManager from './core/fileManager.js';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

function backendTag(m) {
  if (!m || !m.backend) return '';
  const model = m.model ? `/${m.model}` : '';
  const effort = m.reasoningEffort ? `/${m.reasoningEffort}` : '';
  return ` · [${m.backend}${model}${effort}]`;
}

function countStatuses(verifiedClaims) {
  const stats = { supported: 0, partially_supported: 0, unsupported: 0, contradicted: 0 };
  for (const v of verifiedClaims) {
    if (stats[v.status] !== undefined) stats[v.status] += 1;
  }
  return stats;
}

export async function runPipeline(pdfPath, onProgress = () => {}, options = {}) {
  const sessionId = randomUUID();
  const prompts = options.prompts ?? await getPrompts();
  const llmConfig = getLlmConfig();
  const emphasis = options.emphasis ?? '';

  const metrics = { parse: {}, analyst: {}, verifier: {}, writer: {} };
  const hasOrchestrator = emphasis.trim() !== '';

  const stagesPlanned = ['parse'];
  if (hasOrchestrator) stagesPlanned.push('orchestrator');
  stagesPlanned.push('analyst', 'verifier', 'writer');
  const stageLabel = (stage) => `[${stagesPlanned.indexOf(stage) + 1}/${stagesPlanned.length}]`;

  onProgress({ stage: 'parse', message: `${stageLabel('parse')} PDF 파싱: ${pdfPath}` });
  const tParse = Date.now();
  const parsed = await parsePdf(pdfPath);
  metrics.parse.durationMs = Date.now() - tParse;
  onProgress({ stage: 'parse', message: `  - 페이지: ${parsed.numPages}, 추출 문자수: ${parsed.fullText.length}` });
  if (parsed.title) onProgress({ stage: 'parse', message: `  - 제목 추정: ${parsed.title}` });

  const paperText = parsed.fullText;

  // 오케스트레이터 (emphasis 있을 때만)
  let directive = EMPTY_DIRECTIVE;
  if (hasOrchestrator) {
    onProgress({ stage: 'orchestrator', message: `${stageLabel('orchestrator')} 오케스트레이터: 강조 사항 해석 중...` });
    const tO = Date.now();
    try {
      directive = await runOrchestrator({
        title: parsed.title,
        abstract: paperText.slice(0, 4000),
        emphasis,
        prompts,
        llm: llmConfig.orchestrator,
        onMeta: m => { metrics.orchestrator = { ...m }; },
      });
    } catch (err) {
      onProgress({ stage: 'orchestrator', message: `  - 오케스트레이터 실패 (기본 흐름으로 계속): ${err.message}` });
      directive = EMPTY_DIRECTIVE;
    }
    metrics.orchestrator = metrics.orchestrator || {};
    metrics.orchestrator.durationMs = Date.now() - tO;
    onProgress({ stage: 'orchestrator', message: `  - 해석: ${directive.interpretedEmphasis || '(기본 흐름)'}` });
    if (directive.additionalAuditTasks.length) {
      onProgress({ stage: 'orchestrator', message: `  - 추가 감사 ${directive.additionalAuditTasks.length}건 계획됨` });
    }
    if (directive.additionalReportSections.length) {
      onProgress({ stage: 'orchestrator', message: `  - 추가 섹션 ${directive.additionalReportSections.length}건 계획됨` });
    }
  }

  const hasAudits = directive.additionalAuditTasks.length > 0;
  if (hasAudits) {
    stagesPlanned.splice(stagesPlanned.indexOf('verifier') + 1, 0, 'audits');
    onProgress({ stage: 'orchestrator', message: `  - 총 ${stagesPlanned.length}단계로 확정 (감사 ${directive.additionalAuditTasks.length}건 포함)` });
  }

  onProgress({ stage: 'analyst', message: `${stageLabel('analyst')} 분석가: claim 추출 중... (focus: ${directive.extractionFocus || '없음'})` });
  const tA = Date.now();
  const analystOut = await runAnalyst({
    paperText,
    prompts,
    emphasis,
    extractionFocus: directive.extractionFocus,
    llm: llmConfig.analyst,
    onMeta: m => { metrics.analyst = { ...m }; },
  });
  metrics.analyst.durationMs = Date.now() - tA;
  onProgress({
    stage: 'analyst',
    message: `  - claim ${analystOut.claims?.length ?? 0}개 · ${Math.round(metrics.analyst.durationMs / 1000)}s · in ${metrics.analyst.usage?.input_tokens || 0} / out ${metrics.analyst.usage?.output_tokens || 0} 토큰${backendTag(metrics.analyst)}`,
    meta: metrics.analyst,
  });
  onProgress({ stage: 'verifier', message: `${stageLabel('verifier')} 검증가: claim별 retrieval + 배치 검증 (focus: ${directive.verificationFocus || '없음'})` });
  const tV = Date.now();
  const verifiedClaims = await runVerifier({
    paperText,
    prompts,
    claims: analystOut.claims ?? [],
    verificationFocus: directive.verificationFocus,
    llm: llmConfig.verifier,
    onMeta: m => { metrics.verifier = { ...m }; },
  });
  metrics.verifier.durationMs = Date.now() - tV;
  const stats = countStatuses(verifiedClaims);
  onProgress({
    stage: 'verifier',
    message: `  - supported ${stats.supported} · partial ${stats.partially_supported} · unsupported ${stats.unsupported} · contradicted ${stats.contradicted} · ${metrics.verifier.calls || 0}회 호출 · ${Math.round(metrics.verifier.durationMs / 1000)}s · in ${metrics.verifier.totalInputTokens || 0} / out ${metrics.verifier.totalOutputTokens || 0} 토큰${backendTag(metrics.verifier)}`,
    meta: metrics.verifier,
  });

  // focused audits (병렬)
  let auditResults = [];
  if (hasAudits) {
    onProgress({ stage: 'audits', message: `${stageLabel('audits')} 감사 ${directive.additionalAuditTasks.length}건 병렬 실행 중...` });
    const tAudit = Date.now();
    const settled = await Promise.allSettled(
      directive.additionalAuditTasks.map(task => runFocusedAudit({ paperText, task, llm: llmConfig.audit }))
    );
    auditResults = settled.map((r, i) => r.status === 'fulfilled' ? r.value : {
      taskId: directive.additionalAuditTasks[i].id,
      name: directive.additionalAuditTasks[i].name,
      findings: [],
      verdict: '실행 실패',
      notes: r.reason?.message ?? String(r.reason),
    });
    metrics.audits = { count: auditResults.length, durationMs: Date.now() - tAudit };
    onProgress({ stage: 'audits', message: `  - 완료 ${auditResults.length}건 · ${Math.round(metrics.audits.durationMs / 1000)}s` });
  }

  onProgress({ stage: 'writer', message: `${stageLabel('writer')} 작가: 한국어 리포트 작성 중...` });
  const tW = Date.now();
  const report = await runWriter({
    title: analystOut.title || parsed.title,
    verifiedClaims,
    reproducibility: analystOut.reproducibility,
    prompts,
    emphasis,
    auditResults,
    reportSectionsToEmphasize: directive.reportSectionsToEmphasize,
    additionalReportSections: directive.additionalReportSections,
    llm: llmConfig.writer,
    onMeta: m => { metrics.writer = { ...m }; },
  });
  metrics.writer.durationMs = Date.now() - tW;
  onProgress({
    stage: 'writer',
    message: `  - 리포트 ${report.length}자 · ${Math.round(metrics.writer.durationMs / 1000)}s · in ${metrics.writer.usage?.input_tokens || 0} / out ${metrics.writer.usage?.output_tokens || 0} 토큰${backendTag(metrics.writer)}`,
    meta: metrics.writer,
  });

  const totalMs = (metrics.parse?.durationMs ?? 0)
    + (metrics.orchestrator?.durationMs ?? 0)
    + (metrics.analyst?.durationMs ?? 0)
    + (metrics.verifier?.durationMs ?? 0)
    + (metrics.audits?.durationMs ?? 0)
    + (metrics.writer?.durationMs ?? 0);
  metrics.totalMs = totalMs;

  // ===== 영속화 (실패 시 rollback, 분석 결과는 그대로 반환) =====
  let savedPaperId = null;
  let savedAnalysisId = null;
  const persistedPaperId = { value: null };
  const persistedAnalysisId = { value: null };
  try {
    await library.init();
    const sourceFile = options.sourceFile || path.basename(pdfPath);
    const paperRow = await library.createPaper({
      title: analystOut.title || parsed.title || '제목 없음',
      authors: null,
      year: null,
      sourceFile,
      folderId: null,
    });
    persistedPaperId.value = paperRow.id;

    // PDF 영구 위치로 이동/복사
    if (options.copyPdfMode) {
      await fileManager.copyPdf(pdfPath, paperRow.id);
    } else {
      await fileManager.adoptPdf(pdfPath, paperRow.id);
    }
    await library.updatePaperPdfPath(paperRow.id, fileManager.paperSourcePath(paperRow.id));

    const analysisRow = await library.createAnalysis({
      paperId: paperRow.id,
      durationMs: totalMs,
      configSnapshot: JSON.stringify(options.llmConfigSnapshot || {}),
      reportPath: 'placeholder',
      metricsPath: 'placeholder',
      claimsPath: 'placeholder',
    });
    persistedAnalysisId.value = analysisRow.id;

    const actualPaths = await fileManager.writeAnalysisFiles(paperRow.id, analysisRow.id, {
      reportMd: report,
      claimsJson: verifiedClaims,
      metricsJson: { ...metrics, directive, auditResults },
    });
    await library.updateAnalysisPaths(analysisRow.id, actualPaths);

    // paperText 캐시 (chat 재파싱 제거용)
    await fileManager.writePaperText(paperRow.id, paperText);

    savedPaperId = paperRow.id;
    savedAnalysisId = analysisRow.id;
  } catch (e) {
    console.error('[library] persist failed:', e);
    if (persistedAnalysisId.value !== null) {
      try { await library.deleteAnalysis(persistedAnalysisId.value); }
      catch (e2) { console.error('[library] rollback analysis failed:', e2); }
    }
    if (persistedPaperId.value !== null) {
      try { await library.deletePaper(persistedPaperId.value); }
      catch (e2) { console.error('[library] rollback paper failed:', e2); }
    }
    savedPaperId = null;
    savedAnalysisId = null;
  }

  return {
    report,
    parsed,
    sessionId,
    paperText,
    analyst: analystOut,
    verifiedClaims,
    stats,
    metrics,
    directive,
    auditResults,
    paperId: savedPaperId,
    analysisId: savedAnalysisId,
  };
}

// CLI 모드: 직접 실행 시
if (path.basename(process.argv[1] ?? '') === 'pipeline.js') {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Usage: node pipeline.js <pdfPath>');
    process.exit(1);
  }
  try {
    const { report, sessionId, stats, metrics, directive, auditResults, paperId, analysisId } = await runPipeline(
      pdfPath,
      p => console.log(p.message),
      { sourceFile: path.basename(pdfPath), copyPdfMode: true, llmConfigSnapshot: getLlmConfig() },
    );
    const outPath = path.resolve(path.dirname(pdfPath), 'report.md');
    await writeFile(outPath, report, 'utf8');
    console.log(`Saved: ${outPath}`);
    console.log(`  - sessionId: ${sessionId}`);
    if (paperId != null) console.log(`  - library: paperId=${paperId}, analysisId=${analysisId}`);
    console.log(`  - verification: supported ${stats.supported}, partial ${stats.partially_supported}, unsupported ${stats.unsupported}, contradicted ${stats.contradicted}`);
    if (directive && directive.interpretedEmphasis) {
      console.log(`  - orchestrator interpretation: ${directive.interpretedEmphasis}`);
      if (directive.extractionFocus) console.log(`      extraction focus: ${directive.extractionFocus}`);
      if (directive.verificationFocus) console.log(`      verification focus: ${directive.verificationFocus}`);
      if (auditResults && auditResults.length) {
        console.log(`  - audit results (${auditResults.length}):`);
        for (const a of auditResults) {
          console.log(`      [${a.name}] ${a.verdict}`);
        }
      }
    }
    const totalMs = (metrics.parse?.durationMs ?? 0)
                  + (metrics.orchestrator?.durationMs ?? 0)
                  + (metrics.analyst?.durationMs ?? 0)
                  + (metrics.verifier?.durationMs ?? 0)
                  + (metrics.audits?.durationMs ?? 0)
                  + (metrics.writer?.durationMs ?? 0);
    console.log('  - stage metrics:');
    console.log(`      analyst   ${Math.round((metrics.analyst.durationMs || 0) / 1000)}s . in ${metrics.analyst.usage?.input_tokens || 0} / out ${metrics.analyst.usage?.output_tokens || 0}`);
    console.log(`      verifier  ${Math.round((metrics.verifier.durationMs || 0) / 1000)}s . ${metrics.verifier.calls || 0} calls . in ${metrics.verifier.totalInputTokens || 0} / out ${metrics.verifier.totalOutputTokens || 0}`);
    console.log(`      writer    ${Math.round((metrics.writer.durationMs || 0) / 1000)}s . in ${metrics.writer.usage?.input_tokens || 0} / out ${metrics.writer.usage?.output_tokens || 0}`);
    console.log(`      total     ${Math.round(totalMs / 1000)}s`);
  } catch (err) {
    console.error('Failed:', err.message);
    process.exit(1);
  }
}
