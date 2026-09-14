import { decideAsBrain, type EnsembleOptions, type EnsembleResult } from "./ensemble.js";
import type { LlmClient } from "./llm.js";
import type { AccountView, Brain, Decision, WorldState } from "./types.js";

/**
 * The sponsor's model on the same job as ClaudeBrain.
 *
 * Same prompt, same validator, same ensemble, same sizes. The only thing that differs is
 * the HTTP call inside the client it is handed, which is what makes the nightly record a
 * fair comparison between two models rather than between two harnesses.
 */
export class QwenBrain implements Brain {
  readonly name = "qwen";

  /** The counts behind the most recent decision. See the note on ClaudeBrain. */
  lastEnsemble: EnsembleResult | null = null;

  constructor(
    private readonly client: LlmClient,
    private readonly opts: EnsembleOptions,
  ) {}

  async decide(
    world: WorldState,
    account: AccountView,
    rulebookText: string,
  ): Promise<Decision> {
    const { decision, ensemble } = await decideAsBrain(
      this.name,
      this.client,
      world,
      account,
      rulebookText,
      this.opts,
    );
    this.lastEnsemble = ensemble;
    return decision;
  }
}
