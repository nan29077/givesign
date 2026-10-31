# 공유카드 이미지 확대 — 2026-10-31

- 메인: public/assets/givesign-share-v10.png
- 캠페인: public/assets/givesign-campaign-share-v10-1.png ~ -5.png
- 생성형 배경: public/assets/givesign/brand/share-community-v10.webp
- 생성 스크립트: scripts/generate-social-share-cards.mjs
- 가로형·정사각형 확인: output/qa/share-cards-v10-crop-check.png

작은 사진 박스를 없애고 이미지가 1200×630 카드 전체를 채우도록 변경했습니다. 로고는 상단 중앙, 슬로건은 하단 중앙에 배치하고 인물은 가운데에 모았습니다. 공유카드 파일 주소는 v10으로 바꿨습니다. 이전 메시지의 미리보기는 공유 서비스의 캐시에 따라 바로 변경되지 않을 수 있습니다.

내장 image_gen 사용. 최종 생성 프롬프트:

Create a premium warm editorial illustration for a Korean social welfare donation link-preview card. Wide landscape composition, picture fills the entire canvas edge to edge, no inset picture, no border, no blank wide side margins. A friendly Korean volunteer woman gently offering a meal basket to a smiling older Korean man, with a cheerful Korean child beside them; together in a sunlit community garden / welfare center. All three important people clustered close together in the CENTRAL HALF of the frame, faces fully visible, not at edges. Large readable central people, not distant miniatures. Soft rich forest green, warm cream, sage and restrained apricot orange, high-quality gentle 3D editorial realism, polished welcoming social welfare brand mood. Background garden greenery and soft sunlight fill both sides, but no extra people at edges. Keep upper 15% calm cream light for a logo overlay and lower 20% quiet deep-green soft gradient for a slogan overlay. No lettering, numbers, logos, watermarks, text or UI cards. Compose to remain attractive in both a wide 1.91:1 crop and centered square crop, keep all faces in central x 30%-70%, y 30%-60% of image.
