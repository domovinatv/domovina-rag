// Minimalni HTTP klijent prema Meilisearchu (index `segments`).
// Koristi search-only ključ (actions:[search]) — MCP ne piše u Meili; puni ga
// scripts/sync-meili-segments.sh.

export interface MeiliSearchParams {
  q: string;
  filter?: string;
  sort?: string[];
  hitsPerPage?: number;
  page?: number;
  limit?: number;
  facets?: string[];
  matchingStrategy?: "last" | "all";
  attributesToRetrieve?: string[];
  attributesToHighlight?: string[];
  highlightPreTag?: string;
  highlightPostTag?: string;
}

export interface MeiliSearchResponse<T> {
  hits: (T & { _formatted?: Partial<Record<keyof T, string>> })[];
  totalHits?: number;
  estimatedTotalHits?: number;
  facetDistribution?: Record<string, Record<string, number>>;
}

export class MeiliClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async search<T>(index: string, params: MeiliSearchParams): Promise<MeiliSearchResponse<T>> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/indexes/${index}/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`meili ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as MeiliSearchResponse<T>;
  }
}

/** Vrijednost za Meili filter izraz u jednostrukim navodnicima. */
export function meiliQuote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
