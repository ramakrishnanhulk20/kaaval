import { decideAsBrain, type EnsembleOptions, type EnsembleResult } from "./ensemble.js";
import type { LlmClient } from "./llm.js";
import type { AccountView, Brain, Decision, WorldState } from "./types.js";

/**
 * Kaaval's primary language-model brain.
 *
 * It owns no logic of its own. The prompt, the validator and the ensemble are shared
 * with QwenBrain, so when the two disagree the disagreement is the models', which is the
 * comparison this project exists to publish. The client is injected rather than built
 * here so a test can run the whole brain without a network call.
 */
export class ClaudeBrain implements Brain {
  readonly name = "claude";

  /**
   * The counts behind the most recent decision, including how many runs were thrown out
   * as invalid. Decision has no room for it and the number is the one that shows whether
   * a poisoned headline moved anything, so it is kept here for the ledger and the proof.
   */
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
