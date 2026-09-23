/**
 * Code-owned universe configuration: the liquid US large-cap instruments the
 * ingestion pipeline tracks.
 *
 * Sector values are the canonical GICS sector names, seeded here so the
 * `instruments` table does not depend on metadata enrichment (which is
 * best-effort and may return nulls).
 */

export interface UniverseEntry {
  /** Uppercase ticker symbol, e.g. "AAPL". */
  symbol: string;
  /** Canonical GICS sector name, e.g. "Information Technology". */
  sector: string;
  /** Human-readable company name, e.g. "Apple". */
  name: string;
}

/**
 * The 49 liquid US large-caps tracked by the pipeline, frozen so the ingest
 * engine can iterate it safely. Grouped by GICS sector.
 */
export const DEFAULT_UNIVERSE: readonly UniverseEntry[] = Object.freeze([
  // Information Technology
  { symbol: "AAPL", sector: "Information Technology", name: "Apple" },
  { symbol: "MSFT", sector: "Information Technology", name: "Microsoft" },
  { symbol: "NVDA", sector: "Information Technology", name: "NVIDIA" },
  { symbol: "AVGO", sector: "Information Technology", name: "Broadcom" },
  { symbol: "ORCL", sector: "Information Technology", name: "Oracle" },
  { symbol: "CRM", sector: "Information Technology", name: "Salesforce" },
  { symbol: "AMD", sector: "Information Technology", name: "Advanced Micro Devices" },
  // Communication Services
  { symbol: "GOOGL", sector: "Communication Services", name: "Alphabet" },
  { symbol: "META", sector: "Communication Services", name: "Meta Platforms" },
  { symbol: "NFLX", sector: "Communication Services", name: "Netflix" },
  { symbol: "DIS", sector: "Communication Services", name: "Walt Disney" },
  // Consumer Discretionary
  { symbol: "AMZN", sector: "Consumer Discretionary", name: "Amazon" },
  { symbol: "TSLA", sector: "Consumer Discretionary", name: "Tesla" },
  { symbol: "HD", sector: "Consumer Discretionary", name: "Home Depot" },
  { symbol: "NKE", sector: "Consumer Discretionary", name: "Nike" },
  { symbol: "MCD", sector: "Consumer Discretionary", name: "McDonald's" },
  { symbol: "SBUX", sector: "Consumer Discretionary", name: "Starbucks" },
  // Consumer Staples
  { symbol: "PG", sector: "Consumer Staples", name: "Procter & Gamble" },
  { symbol: "KO", sector: "Consumer Staples", name: "Coca-Cola" },
  { symbol: "PEP", sector: "Consumer Staples", name: "PepsiCo" },
  { symbol: "COST", sector: "Consumer Staples", name: "Costco" },
  { symbol: "WMT", sector: "Consumer Staples", name: "Walmart" },
  // Health Care
  { symbol: "UNH", sector: "Health Care", name: "UnitedHealth" },
  { symbol: "JNJ", sector: "Health Care", name: "Johnson & Johnson" },
  { symbol: "LLY", sector: "Health Care", name: "Eli Lilly" },
  { symbol: "ABBV", sector: "Health Care", name: "AbbVie" },
  { symbol: "PFE", sector: "Health Care", name: "Pfizer" },
  { symbol: "TMO", sector: "Health Care", name: "Thermo Fisher" },
  // Financials
  { symbol: "JPM", sector: "Financials", name: "JPMorgan Chase" },
  { symbol: "BAC", sector: "Financials", name: "Bank of America" },
  { symbol: "WFC", sector: "Financials", name: "Wells Fargo" },
  { symbol: "GS", sector: "Financials", name: "Goldman Sachs" },
  { symbol: "V", sector: "Financials", name: "Visa" },
  { symbol: "MA", sector: "Financials", name: "Mastercard" },
  // Energy
  { symbol: "XOM", sector: "Energy", name: "Exxon Mobil" },
  { symbol: "CVX", sector: "Energy", name: "Chevron" },
  { symbol: "COP", sector: "Energy", name: "ConocoPhillips" },
  // Industrials
  { symbol: "CAT", sector: "Industrials", name: "Caterpillar" },
  { symbol: "HON", sector: "Industrials", name: "Honeywell" },
  { symbol: "UNP", sector: "Industrials", name: "Union Pacific" },
  { symbol: "GE", sector: "Industrials", name: "General Electric" },
  { symbol: "BA", sector: "Industrials", name: "Boeing" },
  // Utilities
  { symbol: "NEE", sector: "Utilities", name: "NextEra Energy" },
  { symbol: "DUK", sector: "Utilities", name: "Duke Energy" },
  { symbol: "SO", sector: "Utilities", name: "Southern Company" },
  // Materials
  { symbol: "LIN", sector: "Materials", name: "Linde" },
  { symbol: "SHW", sector: "Materials", name: "Sherwin-Williams" },
  // Real Estate
  { symbol: "PLD", sector: "Real Estate", name: "Prologis" },
  { symbol: "AMT", sector: "Real Estate", name: "American Tower" },
]);