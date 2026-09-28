// Errors whose message is written by this repository, names pools, tokens and status codes only,
// and is therefore safe to put in an alert. Everything else is reported without its message,
// because a provider error can carry the paid RPC URL.

/** No pool can carry the swap of a seizure. */
export class RouteUnavailableError extends Error {}

/** The indexer is behind, down, or answered in a shape the keeper does not read. */
export class IndexerError extends Error {}
