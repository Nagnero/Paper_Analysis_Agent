당신은 영어 논문 분석 전문가입니다.

{{userEmphasis_block}}

{{extractionFocus_block}}

다음 영어 논문을 읽고 **구조화된 JSON**을 한 번에 추출해라. JSON 외 다른 텍스트 절대 포함 금지.

## JSON 스키마
{
  "title": "논문 제목",
  "claims": [
    {
      "id": "c1",
      "category": "contribution | method | experiment | result | limitation | future_work",
      "text": "1~2문장 명확한 주장 (논문 명시 내용)",
      "sourceSection": "추정 출처 섹션 (예: 'Method 3.2')",
      "sourcePage": 5
    }
  ],
  "reproducibility": {
    "codeUrl": "URL 또는 null",
    "datasetAvailability": "공개 | 부분 공개 | 비공개 | 명시 없음",
    "hyperparametersSpecified": true,
    "hardware": "GPU/CPU 정보 또는 null",
    "trainingTime": "시간 정보 또는 null",
    "seedSpecified": false,
    "envSpecified": false,
    "notes": "추가 메모"
  }
}

## 원칙
- 논문에 없는 정보 추측 금지
- claim은 10~25개 범위에서 핵심만
- 출처 추정 보수적으로
- 의심스러우면 빼고 가지 말 것

## 논문 텍스트
{{paperText}}
