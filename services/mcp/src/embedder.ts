// HTTP klijent prema services/embedder (FastAPI, bge-m3).
// Korišten od tool implementacija da pretvore query string u 1024-d vektor.

export class EmbedderClient {
  constructor(private readonly baseUrl: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(`${this.baseUrl}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`embedder ${res.status}: ${body}`);
    }
    const data = (await res.json()) as { vectors: number[][] };
    return data.vectors;
  }

  async embedOne(text: string): Promise<number[]> {
    const v = await this.embed([text]);
    if (v.length === 0 || !v[0]) {
      throw new Error("embedder returned empty vectors");
    }
    return v[0];
  }

  async health(): Promise<{ status: string; loaded: boolean }> {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`embedder /health ${res.status}`);
    return (await res.json()) as { status: string; loaded: boolean };
  }
}
