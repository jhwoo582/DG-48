<h1 align="center">DG-48 Digger</h1>

<p align="center">
  브라우저에서 돌아가는 포켓 샘플러. 소리를 찾고, 패드에 잘라 넣고, 비트를 만드세요.
</p>

<p align="center">
  <a href="https://jhwoo582.github.io/DG-48/"><b>앱 열기</b></a>
  &nbsp;|&nbsp; <a href="README.md">English</a>
  &nbsp;|&nbsp; 한국어
</p>

<p align="center">
  <img src="docs/screenshot.png" width="860" alt="DG-48 Digger: 왼쪽 패드, 가운데 파형 편집기, 오른쪽 유튜브와 샘플링, 아래 스텝 시퀀서">
</p>

## 30초 만에 써보기

1. Chrome이나 Edge에서 [앱을 열고](https://jhwoo582.github.io/DG-48/) **Turn on audio**를 누릅니다.
2. **Space**를 누르면 데모 비트가 재생됩니다.
3. `1 2 3` `Q W E` `A S D` `Z X C`로 패드를 치고, 아래 격자를 눌러 스텝을 찍어 보세요.

만든 것은 모두 브라우저에 저장됩니다.

## 샘플링하기

**아무 탭에서나 (유튜브, 유튜브 뮤직, 소리 나는 건 뭐든)**

1. **Sample**에서 소스를 **Another tab**으로 두고 **Connect**를 누릅니다.
2. 소리가 나오는 탭을 고르고 **탭 오디오 공유**를 켭니다.
3. 원하는 부분이 나오는 동안 **빨간 버튼(또는 `G`)을 누르고 있다가** 떼면 패드에 들어갑니다.
   짧게 톡 누르면 방금 지나간 4초를 담아요. 최근 60초를 항상 기억하고 있어서 조금 늦게 눌러도 괜찮습니다.

담은 뒤에는 파형의 빨간 표시를 끌어서 구간을 다듬거나, **Chop**으로 타격점마다 잘라 여러 패드에 나눌 수 있어요.

**라이브러리에서**

**Library**(`L`)를 누르면 클래식 드럼머신, 실제 악기, Freesound를 둘러볼 수 있어요. ▶로 미리 듣고 **Add**를 누르거나 패드 위로 끌어다 놓으면 됩니다.

## 기능

| | |
| --- | --- |
| **패드** | 12패드 × 4그룹. 기본 키트는 코드로 합성해서 앱에 오디오 파일이 하나도 없습니다. |
| **소리 다듬기** | 구간 자르기, 볼륨, 음정, 팬, 어택, 릴리즈, 리버스, 초크 그룹. One-shot 또는 Gate. |
| **Length** | 템포에 맞춰 1/32부터 1마디 길이에서 소리를 자릅니다. 버튼 하나로 그룹 전체에 적용. |
| **Tempo sync** | 루프를 원래 BPM에서 프로젝트 BPM으로 늘이거나 마디 수에 맞춥니다. 음정 유지 또는 테이프 방식. |
| **Chop** | 샘플을 균등하게, 또는 타격점마다 잘라 다음 패드들에 배치합니다. |
| **YouTube 큐 패드** | 링크를 붙여넣으면 패드가 영상의 시점이 됩니다. 누르고 있으면 그 시점부터 재생. |
| **시퀀서** | 최대 4마디짜리 패턴 16개, 패턴마다 네 그룹을 모두 담습니다. 실시간 녹음, 스윙, 메트로놈, 송 체인. |
| **이펙트** | 센드로 거는 딜레이, 리버브, 코러스, 드라이브와 XY 패드. 마스터 필터와 컴프레서. 펀치인 루프와 필터. |
| **편의** | Undo와 Redo, 모든 슬라이더에서 트랙패드 스와이프, 한글 입력 상태에서도 동작하는 단축키. |

## 키보드

| 키 | 동작 |
| --- | --- |
| `1 2 3` `Q W E` `A S D` `Z X C` | 패드 |
| `Space` | 재생 / 정지 |
| `G` | 누르고 있으면 샘플링, 짧게 누르면 방금 4초 |
| `↑` `↓` | 그룹 |
| `[` `]` | 패턴 |
| `R` | 패턴에 실시간 녹음 |
| `N` | 송 모드 |
| `K` | 키즈 모드 (소리 하나를 음계로 연주) |
| `Y` | 유튜브 큐 패드 |
| `L` | 라이브러리 |
| `T` | 탭 템포 |
| `M` | 메트로놈 |
| `7 8 9 0 - =` | 펀치인 이펙트 |
| `⌘Z` / `⇧⌘Z` | 되돌리기 / 다시 하기 |
| `?` | 전체 단축키 |

트랙패드로 패드 위를 쓸면 위아래는 볼륨, 좌우는 FX 센드가 바뀝니다.

## 직접 실행하기

Node.js 18 이상이 필요합니다.

```bash
npm install
npm run dev
```

`npm run build`를 실행하면 `dist/`에 정적 사이트가 만들어집니다. `main`에 푸시할 때마다 `.github/workflows/deploy.yml`이 GitHub Pages에 배포해요.

## 소리 출처와 라이선스

저장소에는 다른 사람의 오디오 파일이 들어 있지 않습니다. 라이브러리 소리는 쓸 때 원래 출처에서 불러옵니다.

| 출처 | 라이선스 |
| --- | --- |
| [Versilian Community Sample Library](https://github.com/sgossner/VCSL) | CC0 |
| [tidal-drum-machines](https://github.com/ritchse/tidal-drum-machines) | 명시 안 됨. 곡을 공개하기 전에 확인하세요. |
| [Freesound](https://freesound.org) | 소리마다 다름 (CC0, CC BY, CC BY-NC). 검색 결과 옆에 표시됩니다. |

샘플 목록은 [felixroos/dough-samples](https://github.com/felixroos/dough-samples)에서 가져옵니다. Freesound 검색에는 [freesound.org/apiv2/apply](https://freesound.org/apiv2/apply)에서 무료로 받는 API 키가 필요하고, 키는 브라우저에만 저장됩니다.

## 참고

- 앱 안의 유튜브 플레이어는 큐 패드로만 쓰고, 유튜브 개발자 정책에 따라 소리를 녹음하지 않습니다. 녹음하고 공개하는 소리의 권리는 사용자에게 책임이 있습니다.
- Chrome과 Edge에서 가장 잘 동작합니다. Safari와 Firefox에서는 탭 오디오 공유가 지원되지 않아요.
- Teenage Engineering EP-133 K.O. II 같은 소형 하드웨어 샘플러의 작업 방식에서 영감을 받았습니다. Teenage Engineering과는 관계없는 개인 취미 프로젝트입니다.

## 라이선스

[MIT](LICENSE)
