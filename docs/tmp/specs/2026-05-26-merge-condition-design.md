# mergeCondition / autofix 再設計

## 背景

現状の `ralph-loop` は `mergeCondition` と `autofix` の責務がにじんでいる。

- `mergeCondition` は user-facing には merge 条件の設定に見える
- しかし実際には CI 待ちや unresolved comment の扱いまで `mergeCondition` 系の結果に畳み込まれている
- `/ralph-loop` は low-level CLI parser を持っているが、自然言語入口として使いたい意図に対して過剰実装になっている
- `/ralph-loop` の agent handoff 文面が弱く、`set-ralph-loop` を呼んで終わったり、`acceptanceCriteria` を省略しやすい

この設計変更では、`autofix` と `mergeCondition` の責務を整理し、`/ralph-loop` を自然言語入口として再定義する。

## ゴール

- `autofix` を「PR 上の問題を agent に修正継続させるループ」として明確化する
- `mergeCondition` を「autofix 完了後に merge へ進むための条件」として明確化する
- result payload / failure reason / progress 文言を責務に沿って整理する
- `/ralph-loop` の機械的 CLI parse をやめ、agent が自然文や旧 CLI 風文を解釈して `set-ralph-loop` に落とす設計へ寄せる
- preset コマンドは structured handoff を維持する

## 非ゴール

- `qa` を first-class な独立フェーズとして導入すること
- `autofix` を ralph-loop 自身が直接修正する自律修正エンジンに拡張すること
- review / acceptanceCriteria の state reuse 方針を大きく変えること

## 合意した方針

### 型モデル

`autofix` は enum のまま維持する。

```ts
type RalphLoopAutofix = 'none' | 'ci' | 'comment';
```

`mergeCondition` は ADT object に変更する。

```ts
type RalphLoopMergeCondition =
  | { enabled: false }
  | { enabled: true; approved: boolean };
```

`RalphLoopParams` の形は次を目標とする。

```ts
type RalphLoopParams = {
  readonly staticChecks: readonly string[];
  readonly completion: 'edit-only' | 'draft-pr' | 'pr';
  readonly autofix: RalphLoopAutofix;
  readonly mergeCondition: RalphLoopMergeCondition;
  readonly review: boolean;
  readonly acceptanceCriteria?: string;
};
```

ポイント:

- `autofix` は修正ループの戦略
- `mergeCondition` は merge 条件
- `acceptanceCriteria` は独立フェーズとして維持
- 今回は `qa` を正式パラメータには増やさない

### mergeCondition の意味

- `{ enabled: false }`
  - 自動 merge しない
- `{ enabled: true, approved: false }`
  - 他の有効条件と `autofix` をすべて満たしたら merge する
- `{ enabled: true, approved: true }`
  - 他の有効条件と `autofix` を満たし、GitHub PR の approval が付いたら merge する

`approved` は GitHub 側の live state を SSoT として扱う。

### autofix の意味

- `none`
  - PR follow-up をしない
- `ci`
  - CI が未解決なら task を reopen し、agent に修正継続させる
- `comment`
  - CI を先に扱い、その後 unresolved comment / review thread を扱う

`comment` は設計上 `ci -> comment` の順序を持つ上位モードとする。

補足:

- CI が存在しない場合、`autofix: 'ci'` は no-op success
- CI が存在しない場合でも、`autofix: 'comment'` は comment 対応だけで成立してよい
- `autofix` は内部で自動修正する機構ではなく、失敗状態を follow-up で main agent に返して継続修正させる既存モデルを維持する

## Validation

### completion 依存

- `autofix !== 'none'` は `completion: 'pr' | 'draft-pr'` のときだけ有効
- `mergeCondition.enabled === true` も `completion: 'pr' | 'draft-pr'` のときだけ有効
- `completion: 'edit-only'` では自動 merge を許可しない

### mergeCondition と autofix の依存

- `completion: 'pr'` の場合
  - `mergeCondition.enabled === true` と `autofix: 'none'` の組み合わせを許可する
- `completion: 'draft-pr'` かつ `mergeCondition.enabled === true` の場合
  - `autofix !== 'none'` を必須とする

理由:

- `draft-pr` から merge へ進む場合は CI 完了後に `Ready for review` へ遷移させるため、CI 待ちの足場が必要
- CI 待ち責務は `mergeCondition` に戻さず、`autofix` 側に残す

### draft PR と auto-merge

GitHub Docs 上は draft pull request はそのまま merge できないため、`completion: 'draft-pr'` かつ `mergeCondition.enabled === true` の場合は、mergeCondition フェーズ内で自動的に `Ready for review` へ遷移させる。

この挙動は `approved` の真偽にかかわらず適用する。つまり:

- `draft-pr + mergeCondition.enabled=true + approved=false`
  - `autofix` 完了
  - auto `Ready for review`
  - 即 merge
- `draft-pr + mergeCondition.enabled=true + approved=true`
  - `autofix` 完了
  - auto `Ready for review`
  - approval 待ち
  - merge

## 実行フロー

実行順は次のように整理する。

1. static checks
2. review
3. acceptance criteria
4. completion checks
5. completion automation
6. autofix
7. mergeCondition
8. merge

後半の意味づけ:

- `autofix` は PR 上の問題を解決するための再入可能な修正ループ
- `mergeCondition` は merge 直前条件の評価と必要な待機・状態遷移を担当する

### mergeCondition フェーズの責務

`mergeCondition` フェーズは以下を担当する。

- `approved: true` の場合の approval wait
- `completion: 'draft-pr'` かつ `mergeCondition.enabled === true` の場合の auto `Ready for review`
- 最終 merge 実行

### autofix 中は merge 禁止

`autofix` 実行中は merge しない。これは user-facing 設定ではなく、内部不変条件として扱う。

## 再入ループ

approval 待ちや merge 直前の間に状況が変わった場合、`autofix` へ戻す。

対象:

- approval 待ち中に unresolved comment が追加された
- approval 待ち中に CI が passed から pending / fail に戻った

挙動:

1. `autofix` を再実行する
2. `autofix` が再度完了したら `mergeCondition` へ戻る
3. `approved: true` の場合は approval を再度待つ

この再入ループは上限なしで回す。

### reuse / invalidation

- `review` は一度通れば再利用する
- `acceptanceCriteria` も一度通れば再利用する
- `approved` はキャッシュせず、GitHub 側 live state を毎回確認する

autofix によって新しい commit が追加されても、review / acceptanceCriteria の pass 結果は失効させない。

## 実行状態モデル

`ActiveRalphLoop.state` には review / acceptanceCriteria だけでなく、実行フェーズを持たせる。

例:

```ts
type RalphLoopPhase = 'idle' | 'autofix-ci' | 'autofix-comment' | 'merge-condition';

type RalphLoopState = {
  readonly review: PendingAgentCheckState | PassedAgentCheckState;
  readonly acceptanceCriteria: PendingAgentCheckState | PassedAgentCheckState;
  readonly phase: RalphLoopPhase;
};
```

意図:

- `autofix 中は merge 不可` を状態として表現できる
- 進捗表示を責務に沿って出せる
- 再入ループの制御点が明確になる

## 結果 ADT / payload

### failure reason

`RalphLoopResult.reason` は次へ再編する。

- `static-check-failed`
- `review-rejected`
- `acceptance-criteria-rejected`
- `completion-check-failed`
- `completion-automation-failed`
- `autofix-ci-failed`
- `autofix-comment-failed`
- `merge-approval-failed`
- `merge-command-failed`

### payload 分離

`autofix` と `mergeCondition` の責務に合わせて payload を分割する。

追加/再整理対象:

- `autofixChecks?: readonly RalphLoopCommandResult[]`
- `autofixDetails?: ...`
- `mergeConditionChecks?: readonly RalphLoopCommandResult[]`
- `mergeConditionDetails?: ...`

現状 `mergeConditionChecks` 側に押し込まれている CI/comment 系の結果は `autofix*` 側へ移す。

## コマンド契約

### set-ralph-loop

`mergeCondition` は新 object schema のみ受け付ける。旧 string 形式は受け付けない。

例:

```ts
mergeCondition: { enabled: false }
mergeCondition: { enabled: true, approved: false }
mergeCondition: { enabled: true, approved: true }
```

### preset commands

`/ralph-check` `/ralph-pr` `/ralph-delegate` は、今後も preset が確定値を組み立てて agent に渡す structured handoff を維持する。

preset の意味:

- `/ralph-check`
  - `completion: 'edit-only'`
  - `autofix: 'none'`
  - `mergeCondition: { enabled: false }`
- `/ralph-pr`
  - `completion: 'draft-pr'`
  - `autofix: 'comment'`
  - `mergeCondition: { enabled: false }`
- `/ralph-delegate`
  - `completion: 'pr'`
  - `autofix: 'comment'`
  - `mergeCondition: { enabled: true, approved: false }`

`acceptanceCriteria` は requirement から推定して入れる方針にする。推定できない場合は省略可だが、安易に落とさないよう follow-up 文面で強く指示する。

### /ralph-loop

`/ralph-loop` は low-level CLI parser を廃止し、自然言語入口として扱う。

ただし旧 CLI 風文面も agent が解釈対象として受ける。

agent への follow-up 文面では次を明示する。

- request を解釈して `completion` / `autofix` / `mergeCondition` / `review` / `acceptanceCriteria` を構成すること
- 自然文だけでなく旧 CLI 風文面も読み取って structured params に落とすこと
- 曖昧な指定は安全側デフォルトへ倒すこと
- merge / autofix のような強い意図が明示されている場合は、必要な依存 option を補完してよいこと
- `set-ralph-loop` を一度呼んで終わらず、そのまま実作業に入ること
- `acceptanceCriteria` を安易に省略しないこと

安全側デフォルトは以下を基準とする。

- `completion: 'edit-only'`
- `autofix: 'none'`
- `mergeCondition: { enabled: false }`

## README / 文言更新

README は次を更新する。

- option model の `mergeCondition` 説明を object ベースへ変更
- `/ralph-loop` を自然文入口として説明し直す
- 旧 CLI-style parser ではなく agent interpretation ベースであることを記載する
- `/ralph-delegate` の merge 設定を新形式に更新する
- `draft-pr + mergeCondition.enabled=true` のときは auto `Ready for review` を挟むことを明記する
- `acceptanceCriteria` 推定方針を説明する

`extensions/set-ralph-loop.ts` の progress / follow-up 文言も更新する。

例:

- `autofix: 'comment'`
  - “waiting for CI if present, then checking unresolved PR comments...”
- `mergeCondition.enabled && approved=true`
  - “autofix checks passed. waiting for PR approval before merge...”
- `draft-pr + mergeCondition.enabled`
  - auto `Ready for review` を行う旨を通知する

## テスト方針

### 更新対象

- `src/ralph-loop/ralphLoopConfig.service.test.ts`
- `src/ralph-loop/ralphLoop.service.test.ts`
- `src/ralph-loop/ralph-loop-commands.test.ts`
- `src/ralph-loop/activeLoop.service.test.ts`
- README 記載例を前提にしている箇所

### 追加したいケース

- `mergeCondition` object ADT の validation
- `completion: 'pr'` で `mergeCondition.enabled=true` かつ `autofix='none'` を許可する
- `completion: 'draft-pr'` で `mergeCondition.enabled=true` かつ `autofix='none'` を reject する
- `autofix -> mergeCondition` の責務分離
- `autofix-ci-failed` / `autofix-comment-failed`
- `merge-approval-failed` / `merge-command-failed`
- CI が存在しない場合の `autofix: 'ci'` 成功
- CI が存在しない場合でも `autofix: 'comment'` が comment 対応へ進める
- approval 待ち中に comment / CI が変化したとき `autofix` へ戻る
- `draft-pr + mergeCondition.enabled=true` で auto `Ready for review` してから merge 条件へ進む
- `/ralph-loop` parser 削除後の follow-up 生成テスト
- preset が新 `mergeCondition` schema を使うこと

## 実装アプローチ

今回は次の方針で進める。

- `mergeCondition` を string から ADT object へ置き換える
- `autofix` は enum のまま維持する
- 実行フローを `autofix -> mergeCondition` に明確化する
- 結果 ADT / details / progress 文言を責務に沿って再編する
- `/ralph-loop` を自然言語解釈ベースへ寄せる
- preset は structured handoff を維持する

これは「型・validation・実行フロー・文言」をまとめて整える最小整合リファクタであり、今回のスコープに対する推奨案とする。
