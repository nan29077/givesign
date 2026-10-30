# 캠페인 카드뉴스 — 2026-10-30

기관 콘솔의 캠페인 만들기·수정 화면에서 최대 15장의 카드뉴스를 편집할 수 있습니다.

- 이미지+제목·설명 / 완성된 이미지 / 텍스트 전용 구성
- 이미지 직접 업로드(기존 업로드 보안·5MB 제한), HTTPS URL 입력, 복지 이미지 5종 선택
- 크림·초록·살구·화이트 테마, 순서 변경·복제·삭제
- 따뜻한 한 끼·아이들의 내일·이웃 돌봄 3장 구성 템플릿
- 편집기와 공개 상세에서 동일한 레이아웃으로 미리보기
- 본문 이미지는 자르지 않고 원본 비율로 표시; 표지는 대표 썸네일로 사용
- 제목·본문과 카드뉴스는 함께 사용 가능; 카드뉴스가 없는 기존 캠페인은 호환 유지

경로: `/studio/campaigns/new`, `/studio/campaigns/[id]`, `/donate/[code]/campaigns/[id]`

저장: Campaign.cardNews JSONB. 마이그레이션 `20261030140000_campaign_card_news`를 적용합니다. 이전 캠페인은 빈 배열로 시작합니다. 서버는 카드 수·이미지 URL·구성·문자 수를 검증하며 기관 소유권 검사를 유지합니다. 저장할 때 카드뉴스 필드가 생략된 기존 호출은 원래 카드뉴스를 보존합니다.

템플릿 문구는 예시이므로 기관의 실제 사업과 예산에 맞게 수정해야 합니다. 템플릿을 불러온 것만으로 공개되지 않으며, 캠페인 저장과 기존 모금 시작 절차를 사용합니다.

## 공유카드

메인 공유 이미지: public/assets/givesign-share-v9.png (1200×630)
캠페인 공유 이미지: public/assets/givesign-campaign-share-v9-1.png ~ -5.png (1200×630)

선택한 기브싸인 투명 로고 + 기존 생성형 복지 이미지 + 주제별 슬로건을 합성한 카드입니다. 식사·아동·돌봄·지역·동행의 5종 중 캠페인 제목·소개·지원 대상에 맞춰 자동 선택합니다. 캠페인 표지 사진만 그대로 사용하는 방식이 아닙니다. 공유 제목과 설명은 공개 캠페인의 제목·한 줄 소개를 사용하며, 비공개 캠페인 정보는 노출하지 않습니다.

메인 슬로건: 작은 나눔이, 자라나는 희망으로
보조 문구: 후원과 사람을 잇고, 기관의 일을 가볍게

실제 카카오톡 등의 미리보기 수집에는 외부에서 접속 가능한 공개 HTTPS 주소가 필요합니다. localhost는 사용자 컴퓨터 내부 주소이므로 외부 크롤러에서 가져올 수 없습니다. 공유 서비스가 이전 미리보기를 캐시한 경우 새 수집이 필요할 수 있습니다.

## 후원 자동화 메인 배너

파일: public/assets/givesign/donation-automation-banner-v1.webp
내장 image_gen 도구 사용. 프롬프트: 1536x1024 landscape hero background for Korean welfare donation automation; warm green, sage, cream and orange 3D editorial illustration; welfare coordinators using tablet and laptop on right; connected heart, calendar, signed paper, message and receipt pictograms; volunteers helping an older neighbor in background; quiet left area for live headline; no text or third-party logos.

슬로건: 반복되는 후원 업무는 가볍게, 이웃에게 전하는 마음은 더 깊게
배너 클릭: /#donation-automation (메인 자동화 설명 영역)


## 공유 이미지 잘림 개선

원본 사진을 contain으로 전체 표시하고 로고·슬로건·사진을 중앙 600px 안에 배치했습니다. 가로형(1200×630)과 중앙 정사각형(630×630) 미리보기를 확인했습니다. 재생성 스크립트: scripts/generate-social-share-cards.mjs. 검수 이미지: output/qa/share-cards-v9-crop-check.png. 새 파일 주소 v9로 캐시를 구분합니다. 이전에 전송된 메시지의 미리보기는 공유 서비스의 캐시에 따라 바로 갱신되지 않을 수 있습니다.
