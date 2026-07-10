**Spec-Driven Generation (SDG)** is a structured process for building software by maintaining a master specification and using AI to automatically generate code to implement it.

Humans do not write the code or specification by hand. The code is generated based on the specification through a fully automated process. The specification is written by AI through an interactive process where humans answer questions that clarify intentions and remove ambiguity.

***Note:** This process is currently optimized for building headless software, not user interfaces. Use it to build a full stack or frontend at your own risk. It is recommended that you first use this to build the backend for your app and then subsequently build the frontend through a different process.*

**Prerequisites:**
1. An agentic development harness with support for subagents
2. GitHub with CI enabled that agents have access to
# Concepts
The software being developed is called the **product**.

All product requirements are listed in a document called the **spec**.

All requirements in the spec are tested by a separate application called the **test harness**.

All test harness behavior is fully specified in a document called the **test spec**.

The spec and test spec are collectively referred to as the **specs**.

The human running the process is called **Developer**.

Developer initiates work by providing a description, summarizing what work needs to be done, called the **seed**. *The rest of the process is automated and Developer is only brought into the loop when needed.*

## Process Summary

First, the **spec** is updated. Then, the **test spec** is updated to cover all requirements in the **spec**. Then the **test harness** implementation is updated to be in conformance with the **test spec**. Finally, the **product** implementation is updated to be in conformance with the **spec**.

Both **specs** are implementation-agnostic. The **product** could be implemented in a variety of ways, i.e. with different programming languages or frameworks. Similarly, the **test harness** could be implemented in a variety of ways, i.e. also with different programming languages or testing frameworks. The implementation details are not prescribed by either of the **specs**, and the **product** and **test harness** implementation details are not coupled—since these are seen as distinct applications.

# Core Documents
All core documents are located in `specs/` inside the root of the project. Some of these documents may not be required. Files located in the `specs/` directory that are not mentioned in this document are ignored.
## `PROCESS.md`
This file is `PROCESS.md`. It should not be modified by agents running as part of the process defined herein.
## `SPEC.md`
`SPEC.md` is the source of truth for the product.

**Requirements:**
- It MUST define behaviors and NOT prescribe any implementation details.
- It MUST be thorough and handle edge cases.
- It MUST NOT contain contradictions.
- It MUST NOT be verbose.
- It MUST NOT reference or assume knowledge of prior versions of itself.
- It MUST NOT contain migration details from previous versions of itself, unless migration is an explicitly supported feature.
- It MUST NOT define tests or testing strategy.
- It MUST clearly define the interface and contracts by which consumers of the product interact with it.
- It MUST specify the product in a way that is fully blackbox testable, exposing testing seams that enable all behaviors to be tested through E2E tests. In other words, the interface and contracts must be sufficiently powerful to expose routes to test all requirements and edge cases through blackbox means. This includes adding seams and options that are intended for a tester and not necessarily the target customer.
- Test seams MUST be specified in a manner that does not introduce security vulnerabilities.
- It SHOULD be modular, breaking loosely coupled components into their own modules and MUST link to those modules in the spec.
- It MUST define the full interface or contract for interacting with the module in `SPEC.md` itself, rather than in the module document.
- It MUST NOT reference information inside of modules. It only reasons about the interface/contract.
- It MUST NOT reference or link to any other files other than modules.
- It MUST be fully self-contained, NOT requiring any other document to understand it properly (except modules).
- It MAY treat some modules as their own standalone products that are dependencies of the core product, but also could be consumed independently of the product, if appropriate. However, these "dependencies" must be consumed by their interface/contract and MUST NOT be imported as a library—since that would be an implementation detail.
- It MAY describe which external third-party hosted services it depends on, if it is a feature of the product and not an implementation detail.
- It MAY include implementation-agnostic observability behaviors, such as telemetry and logging, and MAY use these as a substitute for test seams when appropriate.
- It SHOULD be specified in a way that allows multiple instances to run in parallel on the same machine, if possible.
### `modules/`
Modules are part of the spec and follow the same rules. They only exist because they keep individual file sizes down. They are given a name and located in `specs/modules`, i.e. `specs/modules/MODULE-NAME.md`.

**Requirements:**
- They MUST be valid specs. In other words, if they were pasted in-line to `SPEC.md` then `SPEC.md` should still be valid.
- They MAY be nested. In other words, a module (the parent) can be further modularized into (child) sub-modules. The parent MUST link to the children. Regardless of the nested relationship, all modules MUST live in the flat `modules/` directory.
- Top-level modules of `SPEC.md` MUST link back to `SPEC.md`.
- Child modules MUST link back to their parent modules.
- They MUST NOT link to other modules that are not their parent module.
- They MUST use the interface and contract defined in the parent and MUST NOT redefine, restate, or extend the interface or contract.
- They MUST be self-contained with respect to the parent and NOT reference information in the parent or other modules, except for the interface/contract.
## `TEST-SPEC.md`
`TEST-SPEC.md` is the source of truth for the test harness.

**Requirements:**
- It MUST fully test all requirements in `SPEC.md`.
- It MUST only test the product requirements through blackbox E2E tests, based on the interfaces, contracts, seams, and observability features specified in `SPEC.md`, without assuming anything about the implementation details.
- It MUST NOT add or remove product requirements defined in `SPEC.md`.
- It MUST NOT prescribe specific code, testing framework, test implementation, or any other implementation details.
- It MUST be compatible with a red-green testing strategy where the test harness is implemented before the product.
- It MUST include self-tests to increase confidence that the test harness is properly implemented prior to product implementation. Self-testing MUST primarily take the form of certification against `CERTIFICATIONS.md`, with additional internal self-tests only for harness behavior that certification does not exercise.
- It SHOULD include negative tests and fuzz/property-based tests, if appropriate.
- It MUST test external third-party hosted dependencies, either by simulating them or by using the actual service (not with production keys), if it is safe and reasonable to do so.
- It SHOULD run in GitHub CI.
- It MUST NOT skip tests that cannot run in GitHub CI, instead those tests MUST be implemented as local-only tests.
- It MUST fully test all spec modules through test modules.
- It SHOULD be specified in a way that allows multiple instances to run in parallel on the same machine, if possible.
### `modules/`
For each "spec module", there must be a "test module" that fully tests it with the same requirements as `TEST-SPEC.md`. Test modules are co-located in the `modules/` directory along with spec modules. The name of the test module prepends `TEST-` to the module name, i.e. spec module `specs/modules/MODULE-NAME.md` is tested by `specs/modules/TEST-MODULE-NAME.md`.

**Additional Requirements:**
- They MUST treat the entire product as a blackbox and test the whole thing E2E. Therefore, the entry point for testing a module is still the interface or contract that consumers of the software use, along with seams and observability features.
- They MUST NOT test requirements outside of their respective spec module.
## `CERTIFICATIONS.md`
`CERTIFICATIONS.md` specifies fake products, called **fixtures**, used to verify that selected tests actually catch the failures they exist to catch. A **conformer** is a fixture that conforms to `SPEC.md` within a stated scope, with the simplest behavior that does so. A **violator** is a conformer with exactly one specified behavioral deviation from `SPEC.md`. A test is **certified** when it passes against the conformer and fails against each violator that targets it.

**Requirements:**
- It MUST describe conformers and violators only in terms of the interfaces, contracts, seams, and observability features defined in `SPEC.md`, and MUST NOT prescribe implementation details. Fixtures are implemented as part of the test harness.
- Each violator entry MUST state the tests it certifies, its scope, its single deviation, and the expected failures: only its certified tests may fail against it, and all other in-scope tests MUST pass.
- It MUST be selective rather than complete: a fixture is justified only by (a) elevated risk of a vacuous pass — negative tests, temporal behavior, tests routed through seams, and the reachability of fuzz/property-based tests — or (b) an empirically demonstrated failure of the test harness to catch a deviation, e.g. from a Bug Report. Reviews of this document enforce these criteria, not completeness.
- It MAY be modularized: fixtures certifying tests in `specs/modules/TEST-MODULE-NAME.md` are located in `specs/modules/CERTIFICATIONS-MODULE-NAME.md` and follow the same rules.
## `IMPLEMENTATION.md`
`IMPLEMENTATION.md` specifies the technical choices required for the implementation, such as programming language, framework, libraries, coding style, and architecture.

**Requirements:**
- It MUST NOT add or remove product or test harness requirements defined in `SPEC.md` or `TEST-SPEC.md`.
- It SHOULD be minimal and high-level.
## `PHILOSOPHY.md`
`PHILOSOPHY.md` is a record of durable principles derived from questions asked of Developer.

**Requirements:**
- First line MUST be: "IMPORTANT: This file may only be edited and interpreted by Liaison. Only Liaison has the full context required to interpret this file. Driver, Engineer, Specialist, and other agents should not infer answers from this file."
- It SHOULD be bullet point formatted.
## `GOALS.md`
`GOALS.md` keeps track of non-negotiable product requirements, but is not the source of truth for the product spec. Instead it is used as a sanity check to ensure `SPEC.md` does not drift from its most important objectives.

**Requirements:**
- It MUST be less than 1000 words.
- It MUST NOT be edited without explicit Developer approval.
- It SHOULD be bullet point formatted.
## `DEVOPS.md`
`DEVOPS.md` defines how to release, merge, and deploy code. It also contains the logic for when these actions should be performed. It can also define when to trigger specific post-update actions like docs updates.
# Temporary Documents
All temporary documents are located in `specs/tmp/` in the root of the project. These files only exist at the time they are needed.

These files are created, consumed, and deleted by agents or Developer as needed through the course of this process. These include:
- `SPEC-PROBLEMS.md`
- `TEST-SPEC-PROBLEMS.md`
- `CERTIFICATIONS-PROBLEMS.md`
- `PATCH-PROBLEMS.md`
- `SEED.md`
- `FIX_PLAN.md`
- `REVIEW.md`

# Patch Documents
All patch documents are located in `specs/patches/` in the root of the project.

Patch documents describe a change that needs to be made to the existing specs and code. Each patch has a short title and an index.

For example, if someone wants to add a "goblin mode" feature to the product, and there are already 11 existing patches, then the patch could be titled `0012-goblin-mode.md`. Short titles must be unique and the index is zero-padded to 4 digits and is the `previous index + 1`, starting at index 1.

There are 2 main types of patch documents:
1. Improvement Proposals (IPs)
2. Bug Reports

If a patch requires changes to `SPEC.md`, it is classified as an IP. Otherwise, it is classified as a bug.

Patches have stages that track their lifecycle. These differ slightly between types.
1. **Proposed**
2. **Accepted**
3. **Applied** (IP only)
4. **Tests Specified** (sometimes skipped by Bug Reports)
5. **Tested**
6. **Implemented**
7. **Complete**

**Requirements:**
- They MUST be classified as either an IP or Bug Report.
- They MUST NOT prescribe specific code changes or implementation details.
- They MAY contain information from GitHub issues, Linear tickets, or other sources for archival purposes (i.e. if a user reports a bug they encountered). This content could reference code and implementation details and is allowed to be preserved, but it is not considered to be an authoritative prescription.
- They MUST NOT reference specific code or implementation details, except for archival purposes.
- They MUST NOT contain direct patches/diffs to any file, including `SPEC.md` and `TEST-SPEC.md`.
- They MUST track their stage.
- They SHOULD include a brief summary for the motivation behind the change.

**IP Requirements:**
- They MUST NOT suggest changes to `TEST-SPEC.md`.
- They MUST suggest changes to `SPEC.md` (including modules, if relevant) with the same rigor and methodology that `SPEC.md` is required to maintain.

**Bug Report Requirements:**
- They MUST NOT suggest changes to `SPEC.md`.
- They MUST target an update to the test harness as a means of catching the error in the product implementation. If there is a bug, there should have been a test that caught it. Bug reports are solely intended to fix the test harness' failure to catch the bug.
- They MAY suggest changes to `TEST-SPEC.md` (including modules and `CERTIFICATIONS.md`, if relevant), but these suggestions MUST be made with the same rigor and methodology that `TEST-SPEC.md` is required to maintain.
- They MAY specify that no changes to `TEST-SPEC.md` are necessary. For example, a test could be correctly specified but the implementation of that test could be wrong.
# Actors
## Developer
As mentioned earlier, Developer is the human managing the product.
## Liaison
Liaison is an agent that manages all communications with Developer. Liaison is the only agent with access to chat history with Developer and `PHILOSOPHY.md`.
## Reviewer
Reviewer receives a prompt, generates a single response for that prompt, and has no memory of past prompts or responses.
## Driver
Driver is an agent that applies suggestions made by Reviewer to the relevant files. Each time Driver is spawned, it applies a single round of feedback from Reviewer—and maintains no memory of past runs.
## Engineer
Engineer is an agent that implements code for the product or test harness.
## Specialist
Specialist is a general agent that performs one-off tasks in a manner that does not bloat the context of the thread that spawns it.
# Sub-Processes

## Asking Developer
If an agent (except Engineer) has a question for Developer, it can send a question that flows through the following process:
1. Liaison reviews questions
2. Liaison attempts to formulate an answer on behalf of Developer, by considering chat history, `PHILOSOPHY.md`, and other relevant files such as `SPEC.md`.
3. If Liaison is confident in its answer, go to step 6. Otherwise, it formulates and sends a question or series of questions to Developer that will help it infer an answer.
4. Developer answers all questions. This may require multiple message exchanges between Developer and Liaison, as follow ups may be needed, etc.
5. If Liaison can infer durable principles from Developer's answer(s), it adds them to `PHILOSOPHY.md`.
6. Liaison formulates and provides a direct answer to the agent asking a question.

From the asking agent's perspective, it is working normally and asking the Developer questions. From the Developer's perspective, it is chatting with Liaison about the product.

If Developer responds to Liaison with something like "whatever you recommend", that means Developer is asking Liaison for a recommendation and not the agent that originally asked the question.

Liaison should also have as much context about the work being performed by the agent asking the question as possible.
## Iterative Refinement
`SPEC.md`, `TEST-SPEC.md`, IPs, and bug reports are improved by iterative refinement prior to being finalized. This occurs when they are first created and when they are updated.

A new Driver agent is spawned for each iteration in a loop until the process halts. At each iteration, Driver resets context and has no memory of past iterations.
1. Reviewer receives a prompt requesting feedback and returns a response which is saved in the temp file `REVIEW.md`.
2. Driver reviews the response and if it deems there are no critical/non-optional suggestions, it performs no work and responds that it has decided to finish the iterative refinement process and halts the loop.
3. If Driver has a question about Developer intent, then it asks Developer via the Asking Developer process. Liaison has access to `REVIEW.md` for context.
4. Driver applies the suggested feedback in the context of the clarifications provided by Developer and rejects Reviewer feedback it deems as misguided.
5. Driver deletes `REVIEW.md` and commits changes.

Driver should generally not look at implemented code, however, if iteratively refining a bug then it can do so to confirm the bug report is on the right track. However, that doesn't mean that the bug report should contain specific fix prescriptions.
### Reviewer Prompts
Reviewer receives a different prompt depending on what is being refined (the "review target") and why. Here is the logic about what is included, categorized by review target:

*Note: `SPEC.md` includes all spec modules, `TEST-SPEC.md` includes all test modules, and `CERTIFICATIONS.md` includes all certification modules.*

**`SPEC.md`:**
- Instructions and stable process summary
- `IMPLEMENTATION.md` (if it exists)
- `GOALS.md`
- Relevant IP (if applicable)
- `SPEC-PROBLEMS.md` (if it exists)

**`TEST-SPEC.md`:**
- Instructions and stable process summary
- `SPEC.md`
- `IMPLEMENTATION.md`
- Relevant Bug Report (if applicable)
- `TEST-SPEC-PROBLEMS.md` (if it exists)

**`CERTIFICATIONS.md`:**
- Instructions and stable process summary
- `SPEC.md`
- `TEST-SPEC.md`
- `IMPLEMENTATION.md`
- Relevant Bug Report (if applicable)
- `CERTIFICATIONS-PROBLEMS.md` (if it exists)

**IP:**
- Instructions and stable process summary
- `GOALS.md`
- `SPEC.md`
- `PATCH-PROBLEMS.md` (if it exists)

**Bug Report:**
- Instructions and stable process summary
- `SPEC.md`
- `TEST-SPEC.md`
- `CERTIFICATIONS.md`
- `PATCH-PROBLEMS.md` (if it exists)
## Identifying Spec Problems
After a document is iteratively refined, it still may contain problems. However, we treat these documents as finalized in later phases of development. Therefore, if an agent in a later phase discovers one or more blocking problems, it must log the problem(s) in a problems file and halt its work. The system will then revert to an iterative refinement stage to resolve the issue.
- If a problem is found in `SPEC.md`, log it to `SPEC-PROBLEMS.md`.
- If a problem is found in `TEST-SPEC.md`, log it to `TEST-SPEC-PROBLEMS.md`.
- If a problem is found in `CERTIFICATIONS.md`, log it to `CERTIFICATIONS-PROBLEMS.md`.
- If a problem is found in an IP or bug report, log it to `PATCH-PROBLEMS.md`.

Blocking issues are any of the following:
1. Contradictions in the requirements
2. Impossible or untestable requirements
3. Anything else that blocks testing or implementation.

Ambiguities, factual errors, and other issues only count as blocking issues if they make it impossible to test or implement the product.
## Ralph Loop
Engineer is run in a loop until it achieves its goal (to implement either the product or test harness), with fresh context in each iteration. Below is what it does in each iteration.

*Note: A custom engineering workflow MAY be configured in place of the ralph loops in phases 9 and 10, provided it upholds the same completion standard — full spec-compliance review by multiple subagents, all required tests and checks passing locally and in CI, code review resolved — and keeps test harness implementation separate from product implementation.*

**Notes:**
1. "finishes the iteration" means that it commits any changes it made, pushes to the remote branch, performs no further work, and then ends the current iteration. This doesn't mean the ralph loop is done, it means that a new iteration will take over where it left off.
2. Determining if the implementation is in full spec compliance requires using multiple subagents to comprehensively review the relevant spec and implemented code to subjectively determine if the code fully meets all requirements. Aside from the agent reviewing the implementation and spec, the implementation must pass all required tests locally and in CI. When implementing the test harness, this means all test harness self-tests must pass. When implementing the product, this means **all** tests must pass.
3. When the final task is removed from `FIX_PLAN.md`, then `FIX_PLAN.md` is also deleted.
4. If Engineer learns anything new about how to build, lint, or run the code, it adds these instructions to `AGENTS.md` at the root of the project. No other information should be added to `AGENTS.md`.

**Iteration Flow:**
1. Reviews `SPEC.md`, `TEST-SPEC.md`, `CERTIFICATIONS.md`, and `IMPLEMENTATION.md` and the goal it is given.
2. Reviews `FIX_PLAN.md`, if it exists.
3. If `FIX_PLAN.md` does not exist, it determines if the implementation is in full spec compliance. If it is in full compliance, it runs the Code Review Sub-Flow. If the spec is not compliant, it creates a granular plan based on the findings to implement the spec and saves it to `FIX_PLAN.md`. To keep the context window short, it then finishes the iteration.
4. If `FIX_PLAN.md` exists, it picks a single task in `FIX_PLAN.md` that it will work on for the rest of the iteration.
5. Uses subagents to research if the task it picked is already implemented properly.
6. If the task is already implemented properly, it removes it from `FIX_PLAN.md`, and finishes the iteration.
7. If the task is not already implemented properly, it attempts to implement it.
8. If there is something wrong with the task, it removes it from `FIX_PLAN.md`, adds any additional tasks if needed, and finishes the iteration.
9. When the attempted implementation is complete, it finishes the iteration.

**Code Review Sub-Flow**
*This is intended to only be run at the end when full spec compliance has been met. Code review may not be set up, in which case this just finishes the iteration and exits the ralph loop. Using multiple subagents is encouraged for this flow.*
1. Reviews all code review comments on the PR.
2. Rejects ones that are bad or misguided.
3. If any non-rejected comments remain, adds them to `FIX_PLAN.md` and finishes the iteration (does not implement changes in this iteration).
4. If no non-rejected comments remain, commits and exits the ralph loop. To be clear, at this point there should be no non-rejected code review comments, no `FIX_PLAN.md`, and there should be full spec compliance.

# Process
*When this process is run as part of an update/patch, the stage must be tracked in the patch document. **Start Stage:**... indicates that at the beginning of the phase, the patch document tracking must be set to the specified stage. **End Stage:**... indicates that at the end of the phase, the patch document tracking must be set to the specified stage*
## Phase 0
Specialist audits the state of the project to determine if there is an active process that needs to be resumed. If so, it jumps to the appropriate phase.
## Phase 1
If `SEED.md` is not present, then Liaison asks Developer for the seed and creates `SEED.md` on Developer's behalf.
## Phase 2
Specialist triages the seed according to the following logic:
1. If no `SPEC.md` currently exists, this is classified as the **initial build**.
2. If `SPEC.md` exists, and the seed describes a change that requires an update to `SPEC.md`, this is classified as an **improvement** (patch).
3. If `SPEC.md` exists, and the seed describes a change that does not require an update to `SPEC.md`, this is classified as a **bug** (patch).

If it is the initial build, Specialist drafts the initial `SPEC.md` and commits when done. Then, jump to phase 4.

If it is a patch, Specialist drafts the initial patch document for the improvement proposal or bug and commits it to a new branch with a name in the format `patch/short-title` and uses the Asking Developer process to resolve ambiguities. This patch document will be referred to as "the patch" for the rest of this workflow.

In both cases, Specialist uses the Asking Developer process to clarify ambiguities and ensure the document is in line with the Developer's intentions.

## Phase 3
**Start Stage:** Proposed
**End Stage:** Accepted

The patch is iteratively refined.

Through the iterative refinement process, it may be necessary to reclassify bugs as improvements and vice versa.

If, at the end of the iterative refinement process, the patch is classified as a bug that requires changes to `TEST-SPEC.md`, jump to phase 6. If it requires changes only to `CERTIFICATIONS.md`, jump to phase 7. If neither needs changes, list the fixes that need to be made to the test harness in `FIX_PLAN.md` and jump to phase 9.

## Phase 4
**Start Stage:** Accepted
**End Stage:** Applied

Iteratively refine `SPEC.md`.

If a contradiction is discovered between `GOALS.md` and `SPEC.md` at this phase, it must be resolved either by suggesting an update to `GOALS.md` or by changing `SPEC.md` in a manner that is acceptable to Developer.

If Driver finds a blocking issue due to a problem in the patch, log the problem to `PATCH-PROBLEMS.md` and jump back to phase 3.
## Phase 5
If `IMPLEMENTATION.md` does not exist, Specialist drafts an initial version and uses the Asking Developer process to confirm that it matches Developer preferences.

If `TEST-SPEC.md` does not exist, Specialist drafts an initial version based on `SPEC.md`.
## Phase 6
**Start Stage (IP):** Applied
**Start Stage (Bug):** Accepted

Iteratively refine `TEST-SPEC.md`.

If Driver finds a blocking issue due to a problem in `SPEC.md`, log the problem to `SPEC-PROBLEMS.md` and jump back to phase 4.
## Phase 7
**End Stage:** Tests Specified

If new or updated `CERTIFICATIONS.md` entries are needed, Specialist walks `TEST-SPEC.md` and drafts them per the selection criteria of `CERTIFICATIONS.md`.

Iteratively refine `CERTIFICATIONS.md`.

If Driver finds a blocking issue due to a problem in `TEST-SPEC.md`, log it to `TEST-SPEC-PROBLEMS.md` and jump back to phase 6. If the problem is in `SPEC.md`, log it to `SPEC-PROBLEMS.md` and jump back to phase 4.
## Phase 8
Specialist updates scaffolding based on the requirements in `SPEC.md`, `TEST-SPEC.md`, `CERTIFICATIONS.md`, and `IMPLEMENTATION.md`, if needed.

The product as defined in `SPEC.md` and the test harness as defined in `TEST-SPEC.md` are considered to be different programs. Ideally, the project should be structured as a monorepo, if the tech stack supports it.

## Phase 9
**Start Stage (Bug without `TEST-SPEC.md` or `CERTIFICATIONS.md` changes):** Accepted
**Start Stage (Other):** Tests Specified
**End Stage:** Tested

Use a ralph loop to ensure the test harness implementation is fully adherent to `TEST-SPEC.md` and `CERTIFICATIONS.md`, but do not work on the product implementation. All harness self-tests (including certifications) must pass and product tests may fail before completion.

If Engineer finds a blocking problem in `TEST-SPEC.md`, log it to `TEST-SPEC-PROBLEMS.md` and jump back to phase 6.

If Engineer finds a blocking problem in `CERTIFICATIONS.md`, log it to `CERTIFICATIONS-PROBLEMS.md` and jump back to phase 7.

## Phase 10
**Start Stage:** Tested
**End Stage:** Implemented

Use a ralph loop to ensure the product implementation is fully adherent to `SPEC.md`. All tests must pass before completion.

If Engineer finds a blocking problem in `TEST-SPEC.md`, log it to `TEST-SPEC-PROBLEMS.md` and jump back to phase 6. This might occur if `TEST-SPEC.md` specifies a test that tests for behavior that contradicts what is required in `SPEC.md`.

If Engineer finds a blocking problem in `CERTIFICATIONS.md`, log it to `CERTIFICATIONS-PROBLEMS.md` and jump back to phase 7.

If Engineer finds a blocking problem in `SPEC.md`, log it to `SPEC-PROBLEMS.md` and jump back to phase 4.

## Phase 11
**Start Stage:** Implemented
**End Stage:** Complete

Specialist handles release, deploy, merge, and other relevant actions. If `DEVOPS.md` does not clearly define how to handle this, Specialist uses the Asking Developer process. Upon clarification, Specialist updates `DEVOPS.md` so that it knows how to handle similar situations in the future.
