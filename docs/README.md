# Harness Wiki

이 디렉터리는 Multi Agent Harness의 설계, 리서치, 의사결정, milestone 문서를 모으는 위키입니다.

루트 [README.md](../README.md)는 사용자와 운영자를 위한 사용 설명서이고, 이 위키는 하네스 자체를 어떻게 발전시킬지 기록하는 개발 문서입니다.

## Start Here

1. [Hermes Autonomous Operations Roadmap](./hermes-autonomy-roadmap.md)

   Hermes를 pipeline 내부 supervisor에서 하네스를 운영하는 top-level autonomous operator로 발전시키기 위한 전체 개발 지도입니다.

2. [Harness Engineering Roadmap](./harness-engineering-roadmap.md)

   하네스를 실행/격리/검증/정책/복구 관점에서 강화하기 위한 개발 지도입니다.

3. [Project Config Guide](./project-config-guide.md)

   대상 프로젝트의 `.harness.json`을 어떤 기준으로 채우고 수정할지 설명하는 사용자 가이드입니다.

4. [Agent Harness Gap Review](./agent-harness-gap-review.md)

   LangChain custom agent harness 관점으로 현재 구조와 앞으로 개발할 항목을 비교한 위키 문서입니다.

## Document Map

현재 문서:

- [Hermes Autonomous Operations Roadmap](./hermes-autonomy-roadmap.md)
- [Harness Engineering Roadmap](./harness-engineering-roadmap.md)
- [Security Model](./security-model.md)
- [Artifact Schema](./artifact-schema.md)
- [Project Config Guide](./project-config-guide.md)
- [Project Config Schema](./config-schema.md)
- [Agent Harness Gap Review](./agent-harness-gap-review.md)
- [Showcase Demo](../demos/showcase/README.md)
- [Hermes Harness Architecture Diagram](./diagrams/hermes-harness-architecture.puml)

향후 문서가 늘어나면 아래 구조로 분기합니다.

```text
docs/
  README.md
  hermes-autonomy-roadmap.md
  agent-harness-gap-review.md
  diagrams/
  research/
  decisions/
  milestones/
```

## Planned Sections

### Research

외부 자료, 개념 비교, 설계 근거를 정리합니다.

예정 예시:

- Hermes Agent 개념 리서치
- Agent memory 설계
- Task queue 설계
- Scheduler/tick 운영 방식

### Decisions

구현 전에 결정한 설계 선택을 기록합니다. ADR처럼 짧게 작성합니다.

예정 예시:

- Queue 저장 위치
- Memory 저장 방식
- Policy 기본값
- Notification adapter 범위

### Milestones

로드맵을 실제 구현 단위로 쪼갠 실행 계획을 기록합니다.

예정 예시:

- M1 Hermes Command Layer
- M2 Task Queue
- M3 Memory Index
- M4 Memory-backed Planning

## Writing Rules

- 사용 설명은 루트 `README.md`에 둡니다.
- 개발 방향, 설계 근거, 구현 순서는 `docs/`에 둡니다.
- 리서치 문서는 구현 계획과 분리하되, roadmap 또는 milestone 문서에서 링크합니다.
- 의사결정 문서는 결론, 이유, 대안, 영향 범위를 짧게 남깁니다.
- runs 산출물이나 민감한 실행 로그는 문서에 그대로 붙이지 않습니다.

## Current Status

[Hermes Autonomous Operations Roadmap](./hermes-autonomy-roadmap.md)의 1차 자율 운영 로드맵은 완료되었습니다.

이제 이 위키의 역할은 완료된 구조를 기준 문서로 유지하고, 선택적인 hardening 후보를 별도 의사결정으로 관리하는 것입니다.

완료된 Milestone 1:

- `harness hermes status`
- `harness hermes plan "<request>"`
- `harness hermes tick`

완료된 Milestone 2:

- `harness hermes enqueue --repo <path> "<request>"`
- `harness hermes queue`
- `harness hermes tick`이 pending task 처리

완료된 Milestone 3:

- `harness hermes memory rebuild`
- `harness hermes memory search "<query>"`
- runs manifest를 memory index로 요약

완료된 Milestone 4:

- `harness hermes plan`이 memory 근거를 함께 출력
- repo별 성공/실패 패턴 반영
- memory가 없을 때 rule-based fallback 유지

완료된 Milestone 5/6:

- 자율 실행 가능 여부를 policy로 판단
- 위험 작업은 사람 검토로 중단
- policy decision을 task와 manifest에 기록
- run별 feedback 저장
- memory와 plan에 feedback 반영

완료된 Milestone 7/8:

- 반복 패턴을 설정/prompt/policy 후보로 승격
- `harness hermes promote --dry-run`
- `harness hermes promote --apply`
- Hermes 운영 상태 markdown report 생성
- `harness hermes report`
- `harness hermes tick` 결과 report artifact 저장

완료된 추가 hardening:

- promotion 제안을 실제 repo에 적용 가능한 patch artifact로 남김
- patch artifact에 `.harness.json` 후보 변경 diff 포함
- branch/protected branch policy를 `hermes tick` 실행 게이트에 연결
- report 외부 채널 adapter 구조 구축
- `webhook`, `slack`, `discord` adapter type과 env 기반 URL 설정 지원
- mock agent 기반 showcase demo 추가

선택 hardening 후보:

아래 항목은 필수 미완료 작업이 아닙니다. 운영 환경이 커지거나 외부 연동 요구가 생길 때 별도 아젠다로 다룹니다.

- memory 저장소 hardening
