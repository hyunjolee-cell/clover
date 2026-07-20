# CLOVER — 부부 공동 자산관리 앱

현조·신영 두 사람이 각자 휴대폰에서 같은 자산 데이터를 함께 관리하는 앱이다.

- 주소: https://hyunjolee-cell.github.io/clover/
- 백엔드: Supabase (`ysoyvoytluacdgivuffl`)
- 배포: GitHub Actions → GitHub Pages (이 저장소 단독. 다른 사이트와 분리됨)

## 처음 설정하는 순서

1. **Supabase 이메일 확인 끄기**
   Dashboard > Authentication > Providers > Email > **Confirm email** 을 OFF
   (가입 즉시 사용할 수 있게 하기 위함)

2. **스키마 실행**
   Dashboard > SQL Editor 에서 [`schema.sql`](./schema.sql) 전문을 붙여넣고 Run
   마지막에 나오는 확인 표의 `found` 값이 `expected` 와 같으면 정상이다.

3. **첫 번째 휴대폰**
   앱 접속 → 계정 만들기 → 공유공간 생성 → 발급된 **공유코드·연결키** 보관

4. **두 번째 휴대폰**
   앱 접속 → 계정 만들기 → 사용자 선택 → 공유코드·연결키 입력 → 연결 완료

이후에는 두 휴대폰 모두 로그인 화면 없이 바로 홈으로 들어간다.

## 파일 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 진입 페이지 |
| `app.js` | 앱 본체 (상태·계산·동기화·화면) |
| `app.css` | 스타일 (라이트 테마 고정) |
| `config.js` | Supabase 주소와 공개 키 |
| `schema.sql` | Supabase 테이블·RPC·보안·Realtime 설정 |
| `sw.js` | 서비스워커 (네트워크 우선, 오프라인 대비) |

## 데이터 구조

공유공간 1건이 `clv_spaces.state` (JSONB) 하나에 담긴다.

```
recurringIncomes  정기소득      [{ id, name, owner, history:[{from, amount}] }]
fixedCosts        월 고정비     [{ id, name, owner, history }]
utilities         공과금 항목   [{ id, name, estimateHistory }]
savings           적금·저축     [{ id, name, owner, history }]
budgets           생활비 예산   [{ id, name, owner, history }]
assets            자산·부채     [{ id, name, kind, category, owner, amount, asOf, memo }]
bonuses           보너스·상여   [{ id, name, owner, date, amount, memo }]
transactions      생활비 내역   [{ id, date, owner, category, place, amount, memo }]
scenarios         포캐스팅      [{ id, name, startMonth, months, annualReturn,
                                  monthlyAdjustment, savingIds, assetIds, debtIds,
                                  includeBonus, goalId }]
goals             자산 목표     [{ id, name, target, dueDate, scenarioId, memo }]
monthly           월별 값       { 'YYYY-MM': { utilityActuals: { [utilityId]: number } } }
```

`history` 는 **적용 시작월** 구조다. 금액을 바꿔도 그 이전 달의 금액은 그대로 남는다.
`savingIds` 등이 `null` 이면 전체 포함을 뜻한다.

## 동기화 방식

- 저장은 `clv_write_space` RPC 한 경로만 쓴다. 상태 저장과 로그 기록이 같은 트랜잭션이다.
- `version` 낙관적 잠금. 상대가 먼저 저장했으면 서버가 최신 상태를 돌려주고,
  앱이 그 위에 내 변경만 다시 얹어 한 번 재시도한다. 조용한 덮어쓰기는 일어나지 않는다.
- 반영은 Realtime(`clv_spaces` UPDATE) 우선, 15초 폴링이 백업이다.
- 네트워크가 끊기면 화면의 변경을 유지한 채 대기열에 넣고, 복구되면 자동 재전송한다.

## 보안

- 로그인한 사용자만 RPC를 실행할 수 있다. `anon` 에게는 실행 권한이 없다.
- 테이블은 RLS로 잠겨 있고, 자기가 속한 공유공간만 읽을 수 있다.
- 변경 로그는 INSERT/UPDATE/DELETE 정책이 없어 사용자가 지울 수 없다.
- 연결키는 원문을 저장하지 않는다. SHA-256 해시만 서버에 있다.
