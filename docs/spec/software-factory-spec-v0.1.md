# Software Factory — Requirements, Architecture & Implementation Plan

- **Document status:** Working specification
- **Version:** 0.1
- **Development environment:** VS Code
- **Primary coding environment:** Claude Code
- **Project owner:** Human approval authority

> This is the owner's original specification, kept verbatim as the baseline.
> Changes to it go through the configuration hygiene process (section 6).

---

## 1. Vision and Objectives

Build an agent-driven software factory that can take a feature request from initial concept through requirements discovery, implementation, testing, security review, validation, and pull request creation.

The factory should operate with a high degree of autonomy while preserving human control over important decisions.

The factory should:

- Automate routine software development activities.
- Maintain consistent requirements and technical specifications.
- Use independent agents for implementation, testing, security, and validation.
- Identify problems and attempt reasonable recovery without constant human intervention.
- Escalate important decisions and unresolved problems through structured inboxes.
- Maintain version control over all project and agent configuration.
- Provide a centralized management interface inside VS Code.

### Core operating principle

Agents should execute work rather than simply provide instructions to the user.

When an agent encounters a decision outside its authority, it should prepare the relevant information, present recommendations, and request approval.

Agents should continue working on unrelated tasks while awaiting human decisions.

## 2. Agent Architecture

The initial factory will have six primary agent roles.

### 2.1 Orchestrator

Responsibility: Coordinate the entire development lifecycle.

The orchestrator is responsible for:

- Receiving feature requirements after the requirements analyst completes them.
- Checking requirements readiness.
- Coordinating architecture and technical decisions.
- Launching the software developer and test engineer.
- Monitoring agent completion.
- Reviewing test results.
- Reviewing security review results.
- Attempting reasonable test reruns when failures occur.
- Investigating repeated failures.
- Routing unresolved problems to the appropriate human inbox.
- Coordinating validation.
- Opening a pull request once all required gates pass.

The orchestrator does not independently override approved requirements, interface contracts, or human decisions.

It must not silently change project configuration or agent definitions.

### 2.2 Requirements Analyst

Responsibility: Turn every feature request into a consistent, testable specification.

This is a mandatory agent for every feature, regardless of complexity.

The analyst conducts an interactive requirements interview, asking questions one at a time.

It produces a feature specification containing:

- Objective and business purpose.
- Expected behavior.
- Functional requirements.
- Acceptance criteria.
- Constraints.
- Edge cases.
- Dependencies.
- Explicit assumptions.
- Security considerations.
- Relevant interface requirements.

Requirements must be sufficiently detailed and testable before implementation begins.

Unresolved assumptions must be submitted for human approval.

The analyst's output becomes the authoritative specification used by the developer, test engineer, security reviewer, and validation judge.

### 2.3 Software Developer

Responsibility: Implement approved feature specifications.

The developer:

- Implements functionality against the approved requirements.
- Follows established project architecture and coding standards.
- Writes maintainable, readable code.
- Uses the approved libraries and technologies.
- Creates or updates documentation as required.
- Implements tests or supporting code as appropriate.
- Uses the shared security review skill.
- Reports completion and implementation details to the orchestrator.

The developer cannot independently make significant architecture or interface contract changes.

Proposed changes must be documented and submitted for approval.

### 2.4 Test Engineer

Responsibility: Independently develop and execute tests against the approved specification.

The test engineer:

- Reviews the feature requirements.
- Creates test cases and acceptance tests.
- Covers expected behavior and relevant edge cases.
- Tests both successful and unsuccessful scenarios.
- Reports test execution results.
- Provides relevant logs and failure information.
- Identifies incomplete tests and environmental problems.

The test engineer works independently from the software developer to avoid simply reproducing the developer's assumptions.

### 2.5 Security Reviewer

Responsibility: Independently evaluate security requirements and implementation.

This is a dedicated agent.

Security review happens at two mandatory gates:

**Gate 1: Requirements review**

- Reviews the feature specification after the requirements interview.
- Identifies potential vulnerabilities and security implications.
- Identifies missing security requirements.
- Submits security decisions requiring human approval to the decision inbox under the Security category.

**Gate 2: Pre-PR review**

- Reviews the completed implementation after tests pass.
- Identifies newly introduced security vulnerabilities.
- Checks compliance with approved security requirements.
- Reports findings to the orchestrator.

Critical security findings block pull request readiness.

The security reviewer does not need to continuously inspect code during development.

**Shared security skill**

The software developer must have access to a security review skill containing the same security criteria used by the security reviewer.

This allows the developer to apply security practices during implementation rather than waiting for the final review.

The skill should have a single authoritative source so security criteria do not drift between agents.

### 2.6 Validation Judge

Responsibility: Independently determine whether the delivered feature meets the approved requirements and coding standards.

The judge must evaluate:

- Compliance with approved feature requirements.
- Whether the delivered functionality satisfies acceptance criteria.
- Code quality.
- Readability.
- Maintainability.
- Architectural compliance.
- Coding standards.
- Test evidence.
- Documentation requirements.

The judge must not fix the implementation.

It produces one of three outcomes:

- PASS
- FAIL
- NEEDS HUMAN REVIEW

Findings are returned to the orchestrator for appropriate action.

The validation judge must remain independent of the developer's implementation decisions.

## 3. Feature Development Lifecycle

The following is the intended workflow.

**Stage 1: Feature Request.** The user describes a feature in natural language. The requirements analyst is automatically assigned.

**Stage 2: Requirements Interview.** The requirements analyst interviews the user, one question at a time. It develops a complete feature specification and acceptance criteria. Assumptions requiring approval are submitted to the decision inbox.

**Stage 3: Security Requirements Review.** The security reviewer independently evaluates the proposed specification. Security concerns requiring human decisions are submitted to the decision inbox under Security. The orchestrator incorporates approved security requirements into the feature specification.

**Stage 4: Requirements Readiness Gate.** The orchestrator checks that the specification has:

- A clear objective.
- Defined expected behavior.
- Testable acceptance criteria.
- Documented constraints.
- Explicit assumptions.
- Resolved blocking decisions.

No feature proceeds with unapproved assumptions.

**Stage 5: Development and Test Preparation.** The orchestrator launches the software developer and test engineer. These agents work independently and in parallel where possible. The developer implements the feature. The test engineer develops the independent test suite. Test execution occurs when the implementation is available.

**Stage 6: Orchestrator Review.** The orchestrator collects and reviews:

- Developer completion results.
- Test execution results.
- Test failures.
- Test execution completeness.

If tests fail, the orchestrator may attempt reruns. If failures persist, the orchestrator investigates the cause and sends an issue to the appropriate inbox. The orchestrator does not automatically accept failed tests.

**Stage 7: Final Security Review.** Once tests pass, the security reviewer performs the independent implementation review. Security findings are returned to the orchestrator. Critical issues block progression.

**Stage 8: Validation Judge.** The validation judge independently checks the implementation against the approved specification and coding requirements. A failure returns the feature to the orchestrator for resolution. A human review requirement is escalated appropriately.

**Stage 9: Pull Request.** The orchestrator confirms that all required gates have passed. It then opens a pull request. The user retains control over the final merge decision.

## 4. Human Decision Management

### 4.1 VS Code Decision Inbox

A centralized decision inbox must be built directly into VS Code.

This is the primary interface through which the user interacts with the factory's decision-making process.

The inbox presents decisions in a prioritized queue.

Each item must provide enough information for an informed decision without requiring the user to investigate the entire project.

**Required decision card information**

- Decision title.
- Category.
- Priority.
- Current status.
- Whether the decision blocks work.
- Context and background.
- Available options.
- Advantages and disadvantages.
- Project impact.
- Agent recommendation.
- Consequences of delaying the decision.

**Available actions**

1. Approve.
2. Reject.
3. Request changes.
4. Ask for more research.
5. Defer.

**Deferral behavior**

Deferring an item must:

- Keep the item visible in the queue.
- Lower its effective priority.
- Preserve its original blocking status.
- Allow the user to restore its priority later.

Deferring a decision does not constitute approval.

Unrelated work should continue while the decision is pending.

### 4.2 Decision Categories

Only the following categories are initially defined.

| Category | Purpose |
|---|---|
| Product | Product requirements, functionality, and behavior |
| Architecture | How the system is designed and constructed |
| Interfaces | Function signatures, parameters, return types, APIs, schemas, and compatibility |
| Assumptions | Unclear requirements and proposed assumptions |
| Security | Security concerns and decisions requiring human approval |

Do not introduce additional categories without discussing them with the user.

**Architecture versus interfaces**

These must remain separate.

Architecture concerns include:

- Design patterns.
- Data structures.
- System boundaries.
- Data flow.
- Component organization.
- Architectural abstractions.

Interface concerns include:

- Function parameters.
- Parameter types.
- Return types.
- API definitions.
- Request and response formats.
- Interface compatibility.
- Contract versioning.

## 5. Testing Inbox

The testing inbox is separate from the decision inbox.

Its purpose is to surface testing problems that require investigation or human intervention.

The orchestrator should handle routine failures autonomously.

Testing inbox items should include:

- Feature being tested.
- Failed test or testing stage.
- Expected result.
- Actual result.
- Relevant logs.
- Relevant agent execution transcripts.
- Root-cause analysis, if available.
- Recovery attempts already made.
- Recommended next action.

The orchestrator should investigate whether failures originated from:

- Test implementation.
- Software implementation.
- Test environment.
- Dependencies.
- Infrastructure.
- Incomplete test execution.

Repeated failures should be escalated rather than retried indefinitely.

The user should not be interrupted by routine failures that the orchestrator successfully resolves.

## 6. Configuration Hygiene Inbox

A separate inbox is required for proposed changes to the software factory's own configuration and instruction files.

The orchestrator may identify improvements, inconsistencies, outdated instructions, or opportunities to improve agent behavior.

However, it cannot apply changes without explicit human approval.

**Files under change control**

Examples include:

- CLAUDE.md
- Agent definitions.
- Skills and skill instructions.
- Workflow definitions.
- Project context files.
- Factory configuration.
- Other instruction and preset files.

**Required approval process**

Every proposed change must include:

1. File being changed.
2. Reason for the proposed change.
3. Current content.
4. Proposed content.
5. Complete diff.
6. Expected benefits.
7. Potential risks and side effects.
8. Recommendation.

The user must explicitly approve every change.

This includes seemingly minor administrative changes, formatting changes, and corrections.

**Version control**

All configuration files must be maintained under Git version control.

Requirements:

- Every approved change must be committed.
- Changes must be traceable.
- Previous versions must remain recoverable.
- Rollback must be supported.
- Unapproved changes must never be applied.

The user retains complete control over the factory's instructions and configuration.

## 7. Technical and Interface Change Control

### 7.1 Architecture Decisions

Major architecture decisions belong to the user.

Examples include selecting:

- Libraries.
- Frameworks.
- Technologies.
- Data structures.
- Design patterns.
- System architecture.
- Major dependencies.

The orchestrator researches available options and presents:

- Problem being solved.
- Available alternatives.
- Advantages and disadvantages.
- Maintenance implications.
- Performance implications.
- Security implications.
- Long-term project impact.
- Recommended approach.

The user approves significant choices before implementation.

Approved decisions should be documented in Architecture Decision Records (ADRs).

### 7.2 Interface Contracts

No undocumented changes to interface contracts.

Function signatures, parameter types, return types, API schemas, and other agreed interface definitions must remain consistent.

Documented and explicitly approved changes are allowed.

Changes must be reflected in:

- Interface documentation.
- Relevant implementation.
- Tests.
- Dependent components.

The test engineer must test against the approved contract.

## 8. Code Comment Standards

Comments should explain why code behaves a certain way, not simply repeat what the code does.

Requirements:

- Comments must be accurate and relevant.
- Comments must remain synchronized with implementation changes.
- Comments should explain non-obvious decisions, constraints, and reasoning.
- Comments must not compensate for unnecessarily complicated code.
- Redundant comments should be avoided.
- No comments should be added simply to increase documentation volume.

Do not enforce a fixed comment-to-code ratio.

Instead, the validation judge should identify suspicious patterns, excessive comments, redundant explanations, and outdated comments.

## 9. Requirements Readiness and Approval

The orchestrator must use a consistent readiness gate.

Required checks:

1. Clear objective.
2. Defined expected behavior.
3. Testable acceptance criteria.
4. Documented constraints.
5. Explicit assumptions.
6. Required human decisions resolved.

The orchestrator may identify missing information and request clarification from the requirements analyst.

Assumptions must be approved by the user before development proceeds.

## 10. Source of Truth and Documentation

The factory must maintain persistent project documentation.

Recommended initial structure:

```
software-factory/
├── CLAUDE.md
├── docs/
│   ├── definition-of-done.md
│   ├── architecture.md
│   ├── interface-contracts.md
│   ├── agent-responsibilities.md
│   ├── development-workflow.md
│   ├── decision-management.md
│   ├── security-standards.md
│   ├── testing-strategy.md
│   ├── features/
│   │   └── feature-template.md
│   └── adr/
│       └── README.md
├── agents/
│   ├── orchestrator/
│   ├── requirements-analyst/
│   ├── software-developer/
│   ├── test-engineer/
│   ├── security-reviewer/
│   └── validation-judge/
├── skills/
│   └── security-review/
└── workflows/
    └── feature-development/
```

This is a proposed structure, not an instruction to create every file immediately.

The documentation should evolve through the configuration hygiene approval process.

## 11. Definition of Done

A feature is not considered complete merely because the developer reports success.

A feature is complete and ready for a pull request only when:

- Requirements are approved.
- Assumptions are approved.
- Security requirements are addressed.
- Implementation is complete.
- Independent tests have passed.
- Orchestrator review is complete.
- Final security review has passed.
- Validation judge has issued PASS.
- Required documentation is updated.
- Interface contracts remain compliant.
- No unresolved blocking issues remain.

The orchestrator opens the pull request only after these conditions are satisfied.

The user makes the final merge decision.

## 12. VS Code User Interface Requirements

The VS Code interface is the user's primary control center.

Initial interface components:

1. Decision Inbox — Product, Architecture, Interfaces, Assumptions, and Security decisions.
2. Testing Inbox — Unresolved testing and execution problems.
3. Configuration Hygiene Inbox — Proposed changes to project and factory instruction files.

The interface should provide:

- Prioritized queues.
- Clear item status.
- Blocking indicators.
- Detailed decision context.
- Agent recommendations.
- Approval and rejection actions.
- Deferral and priority adjustment.
- Links to relevant project files, logs, and diffs.
- A persistent record of decisions.

The interface should make it easy to understand what requires attention without requiring the user to monitor individual agents.

## 13. Implementation Principles

The software factory itself must follow the same standards it enforces on projects.

Specifically:

- Requirements before implementation.
- Documented architecture decisions.
- Approved interface contracts.
- Independent testing.
- Security review.
- Independent validation.
- Git-based change control.
- Human approval for controlled configuration changes.
- Clear agent responsibilities.
- No silent changes to approved specifications.

The factory should be developed incrementally, with its own requirements, tests, and validation gates.

## 14. Items to Define During Detailed Design

The following details have not yet been finalized and should not be assumed:

1. Exact VS Code extension architecture and technology stack.
2. Agent communication and orchestration protocol.
3. Persistent storage mechanism for inbox items and decisions.
4. Agent execution isolation and permissions.
5. Git branching and commit strategy.
6. Test retry limits and escalation thresholds.
7. Security severity definitions.
8. Exact validation judge scoring and evidence requirements.
9. Pull request creation and repository integration.
10. How multiple features and concurrent development workflows are managed.

These should be addressed through requirements discovery and architecture decisions, with the user's approval where appropriate.

---

## 15. Guiding Principle

The software factory should be autonomous in execution, disciplined in engineering, transparent in decision-making, and accountable to the project owner.

The agents are responsible for doing the work. The user is responsible for directing the important decisions.

No significant change to requirements, architecture, interface contracts, assumptions, security policy, or factory configuration should happen silently.
