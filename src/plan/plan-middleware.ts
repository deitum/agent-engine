import { PLAN_INSTRUCTIONS, WRITE_TODOS_DESCRIPTION } from './plan.constants';

/**
 * Gives the agent its planning tool (`write_todos`) and the plan the browser
 * draws as a card.
 *
 * **This has to be installed by hand, and it did not always.** deepagents used
 * to put langchain's `todoListMiddleware` in the stack `createDeepAgent`
 * assembles; since 1.12 it does not. The middleware now arrives only through a
 * *harness profile* — a registry keyed by provider/model, and the only entries
 * that ask for it are OpenAI's Codex models. Every deployment here reaches the
 * model through a gateway under a name that matches no profile, so the agent was
 * left with no planning tool at all: the prompts that tell it to draw one up
 * (this daemon's coding prompt, the app's chat and research instructions) named
 * a tool that did not exist, and a model that tried to obey them got
 * «write_todos is not a valid tool» back — invisibly, since the step is filtered
 * out of the timeline. The plan card simply never appeared.
 *
 * So the middleware is ours to install, on every path that streams a plan, and
 * the check when deepagents is next upgraded is not "is planning still in the
 * defaults" but "does the tool list the model sees still contain `write_todos`"
 * — which is what `plan-middleware.test.ts` asserts against a real agent.
 *
 * Both texts it carries are ours too; see {@link WRITE_TODOS_DESCRIPTION}.
 */

/** langchain's `todoListMiddleware`, through the same `unknown` seam as its callers. */
type TodoListMiddleware = (options: { systemPrompt?: string; toolDescription?: string }) => unknown;

/**
 * Builds the planning middleware for a run: langchain's own, with this daemon's
 * prompt and tool description in place of the stock pair.
 */
export function buildPlanMiddleware(todoListMiddleware: unknown): unknown {
  return (todoListMiddleware as TodoListMiddleware)({
    systemPrompt: PLAN_INSTRUCTIONS,
    toolDescription: WRITE_TODOS_DESCRIPTION,
  });
}
