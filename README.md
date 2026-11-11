# 피클마린 F (PICKLE × FABLE)

피클마린트래킹의 화면(유리나 브리핑·커버 탭·말풍선)을 그대로 쓰고,
데이터는 **페이블 엔진으로 갱신 버튼을 누를 때 직접 조회**하는 탱커선 트래킹 안드로이드 앱입니다.

## 설치

폰에서 [최신 릴리스](https://github.com/jskimlam/pickle-fable-tracking/releases/latest)의 `pickle-fable-tracking.apk` 를 받아 설치합니다.
페이블 쉽트래킹·피클마린트래킹과 **별개 앱**이라 나란히 설치됩니다. 새 버전은 기존 설치본 위에 덮어 설치됩니다.

## 작동 방식

- 갱신 버튼을 누르면 앱이 Wingo Marine(정밀 위치·24시간 항적) → VesselFinder(직전 항만·출항 시각) → 여수 도선예보 순서로 직접 조회합니다.
- API·API 키·상시 수신이 없습니다.
- 실측·추정·미확인을 구분해 표시하고, 데이터에 없는 값은 만들지 않습니다.

자세한 구조와 수정 방법은 [HOW-IT-WORKS.md](HOW-IT-WORKS.md) 를 보세요. (피클 담당 AI용 안내서)

## 엔진

엔진(직접 조회·항로·ETA 계산) 원본은 [fable-ship-tracking](https://github.com/jskimlam/fable-ship-tracking) 입니다.
빌드할 때마다 최신 엔진을 가져오므로, 엔진 수정은 페이블 저장소에서 하면 두 앱에 함께 반영됩니다.

## 서명 키

`android/keystore/fable-sideload.jks` 는 개인 설치용으로 공개해 둔 키입니다. 스토어 배포에는 쓰지 마세요.

## 출처

- 화면 디자인·아이콘·유리나 아바타: 피클마린트래킹
- 지도: Leaflet (BSD-2-Clause), 위성 사진 Esri World Imagery, 일반 지도 © OpenStreetMap contributors
- 육지 다각형: Natural Earth 1:50m (퍼블릭 도메인)
