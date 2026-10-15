/**
 * Next step for each carryover rerun code.
 *
 * The backend already supplies a `hint`, but these say what to CHANGE, which is
 * the question a caller actually has when a launch is refused. Shared by the
 * `start_agent_round` and `run_eval_period` handlers so a refusal reads the same
 * whichever entry point produced it.
 */
export const RERUN_ACTIONS: Readonly<Record<string, string>> = {
  SAME_TRADE_DATE:
    "That trade date already has a round still running. Wait for it via get_round_status, or re-launch with takeover=true to reset that round.",
  ROUND_ALREADY_COMPLETE:
    "That trade date's round is already finished. Use replace=true to deliberately discard its decisions and re-decide, or launch a later trade date.",
  STALE_TRADE_DATE:
    "There is no newer price data than the stream's last mark, so a round would decide on a date it has already passed. Ingest market data for a later date, then relaunch.",
  OUT_OF_SEQUENCE:
    "The requested date is at or before the stream's last applied round_seq, and the fold is forward-only. Launch a later date, or use replace=true to re-decide that date deliberately.",
  UNKNOWN_SIMULATION: "Create the simulation before launching a round into it.",
};
