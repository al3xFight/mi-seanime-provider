/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts" />

/*
 * TioAnime provider para Seanime.
 * Adaptado desde la extensión JiruHub "TioAnime" (v0.1.7).
 *
 * A diferencia de JiruHub -que delegaba las peticiones a servidores externos
 * (YourUpload, Netu/HQQ, Okru, Mp4Upload, Streamtape) a través de un proxy
 * ("Miru-Url")-, aquí usamos `fetch` directamente, ya que Seanime corre en un
 * runtime propio que expone `fetch` y `LoadDoc` de forma global.
 */

class Provider {
    baseUrl = "https://tioanime.com";

    private ua =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    // 1. Configuración del plugin
    getSettings(): Settings {
        return {
            // Servidores realmente soportados/extraídos (ver _extractByEmbedUrl)
            episodeServers: ["YourUpload", "Netu", "Okru", "Mp4Upload", "Streamtape"],
            supportsDub: false, // TioAnime es principalmente subtitulado
        };
    }

    // 2. Búsqueda de Anime
    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const req = await fetch(`${this.baseUrl}/directorio?q=${encodeURIComponent(opts.query)}`);
        if (!req.ok) return [];

        const html = await req.text();
        const $ = LoadDoc(html);
        const results: SearchResult[] = [];

        $("ul.animes li").each((_, el) => {
            const link = el.find("a").attr("href");
            const title = el.find("h3.title").text();
            const cover = el.find("figure img").attr("src") || el.find("img").attr("src");

            if (link && title) {
                results.push({
                    id: link, // ruta relativa, ej: "/anime/naruto"
                    title: title.trim(),
                    url: `${this.baseUrl}${link}`,
                    subOrDub: "sub",
                    // @ts-ignore - depende de si SearchResult soporta cover en tu versión de Seanime
                    image: cover,
                });
            }
        });

        return results;
    }

    // 3. Obtener la lista de episodios
    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const req = await fetch(`${this.baseUrl}${id}`);
        const html = await req.text();

        const episodes: EpisodeDetails[] = [];

        /*
           TioAnime guarda los episodios en un script JS dentro de la página:
           var anime_info = ["4020", "naruto", "naruto"];
           var episodes = [[1, 1], [2, 2], ...];
        */
        const animeInfoMatch = html.match(/var anime_info\s*=\s*\[(.+?)\];/);
        const episodesMatch = html.match(/var episodes\s*=\s*\[(.+?)\];/);

        if (episodesMatch && animeInfoMatch) {
            const animeSlug = JSON.parse(`[${animeInfoMatch[1]}]`)[1];
            const rawEpisodes = JSON.parse(`[${episodesMatch[1]}]`);

            for (const ep of rawEpisodes) {
                const epNum = ep[0];
                episodes.push({
                    id: `/ver/${animeSlug}-${epNum}`,
                    number: epNum,
                    title: `Episodio ${epNum}`,
                    url: `${this.baseUrl}/ver/${animeSlug}-${epNum}`,
                });
            }
        }

        return episodes.reverse(); // Ordenar del episodio 1 en adelante
    }

    // 4. Obtener los servidores/enlaces de video de un episodio
    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        const req = await fetch(episode.url ?? `${this.baseUrl}${episode.id}`);
        const html = await req.text();

        /*
           TioAnime guarda las URLs de los iFrames/reproductores en una variable JS:
           var videos = [["YourUpload","https://..."], ["Netu","https://hqq.tv/..."], ...];
        */
        const videosMatch = html.match(/var videos\s*=\s*(\[.+?\]);/);
        if (!videosMatch) {
            throw new Error("No se encontraron reproductores de video.");
        }

        const videosData: [string, string][] = JSON.parse(videosMatch[1]);

        const result: EpisodeServer = {
            server: _server !== "default" ? _server : "TioAnime",
            headers: {
                Referer: this.baseUrl,
                "User-Agent": this.ua,
            },
            videoSources: [],
        };

        // Orden de preferencia cuando el server pedido es "default"
        const preferred = ["YourUpload", "Netu", "HQQ", "Okru", "Mp4Upload", "Streamtape"];

        const byName: Record<string, string> = {};
        for (const [name, url] of videosData) byName[name] = url;

        const candidates =
            _server !== "default"
                ? videosData.filter(([name]) => name.toLowerCase() === _server.toLowerCase())
                : [
                      ...preferred.filter((n) => byName[n]).map((n) => [n, byName[n]] as [string, string]),
                      ...videosData.filter(([n]) => !preferred.includes(n)),
                  ];

        for (const [serverName, embedUrl] of candidates) {
            try {
                const extracted = await this._extractByEmbedUrl(embedUrl);
                if (!extracted || extracted.url.startsWith("error://")) continue;

                result.videoSources.push({
                    url: extracted.url,
                    type: extracted.url.includes(".m3u8") ? "m3u8" : "mp4",
                    quality: `auto - ${serverName}`,
                    subtitles: [],
                });

                // Los headers de extracción (Referer/Origin específicos) se
                // aplican a nivel de EpisodeServer, así que si encontramos el
                // primero que funciona, lo usamos como referencia principal.
                if (extracted.headers) {
                    result.headers = { ...result.headers, ...extracted.headers };
                }

                if (_server !== "default") break; // ya encontramos el server pedido
            } catch (_) {
                // probar el siguiente servidor
            }
        }

        if (result.videoSources.length === 0) {
            throw new Error("No se pudo extraer ningún enlace de video reproducible.");
        }

        return result;
    }

    // ---- Helpers de extracción (adaptados de JiruHub) ----

    private _refererFor(url: string): string {
        if (!url) return "";
        if (url.includes("yourupload.com")) return "https://www.yourupload.com/";
        if (url.includes("hqq.tv") || url.includes("netu")) return "https://hqq.tv/";
        if (url.includes("ok.ru")) return "https://ok.ru/";
        if (url.includes("streamsb") || url.includes("sbfull") || url.includes("sbplay"))
            return "https://streamsb.com/";
        if (url.includes("fembed") || url.includes("anime789")) return "https://www.fembed.com/";
        if (url.includes("mp4upload")) return "https://www.mp4upload.com/";
        if (url.includes("streamtape")) return "https://streamtape.com/";
        return "https://tioanime.com/";
    }

    private async _extractByEmbedUrl(
        embedUrl: string
    ): Promise<{ url: string; headers?: Record<string, string> } | null> {
        if (embedUrl.includes("yourupload.com")) return this._watchYourUpload(embedUrl);
        if (embedUrl.includes("hqq.tv") || embedUrl.includes("netu")) return this._watchNetu(embedUrl);
        if (embedUrl.includes("ok.ru")) return this._watchOkru(embedUrl);
        if (embedUrl.includes("mp4upload.com")) return this._watchMp4Upload(embedUrl);
        if (embedUrl.includes("streamtape.com")) return this._watchStreamtape(embedUrl);
        return { url: "error://unsupported-server" };
    }

    private async _fetchText(url: string, headers: Record<string, string>): Promise<string | null> {
        try {
            const res = await fetch(url, { headers });
            if (!res.ok) return null;
            const text = await res.text();
            return typeof text === "string" && text.length >= 100 ? text : null;
        } catch (_) {
            return null;
        }
    }

    private async _watchYourUpload(embedUrl: string) {
        const html = await this._fetchText(embedUrl, { Referer: "https://www.yourupload.com/" });
        if (!html) return { url: "error://extraction-failed" };

        const m = html.match(/file:\s*['"]?(https?:\/\/[^'"<>\s]+\.mp4[^'"<>\s]*)/);
        if (!m) return { url: "error://extraction-failed" };

        const videoUrl = m[1];
        if (videoUrl.includes("novideo") || videoUrl.includes("/embed/")) {
            return { url: "error://extraction-failed" };
        }

        return { url: videoUrl, headers: { Referer: "https://www.yourupload.com/" } };
    }

    private async _watchNetu(embedUrl: string) {
        const mirrors = [embedUrl];
        if (embedUrl.includes("hqq.tv")) mirrors.push(embedUrl.replace("hqq.tv", "hqq.net"));
        if (embedUrl.includes("netu.ac")) mirrors.push(embedUrl.replace("netu.ac", "hqq.tv"));
        if (embedUrl.includes("netu.tv")) mirrors.push(embedUrl.replace("netu.tv", "hqq.tv"));

        for (const mirrorUrl of mirrors) {
            const html = await this._fetchText(mirrorUrl, {
                Referer: "https://tioanime.com",
                "User-Agent": this.ua,
                Accept: "text/html,application/xhtml+xml,*/*",
                "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
            });
            if (!html) continue;

            const patterns = [
                /'(https?:\/\/[^']+\.m3u8[^']*)'/g,
                /"(https?:\/\/[^"]+\.m3u8[^"]*)"/g,
                /file:\s*["']?(https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)/g,
                /source\s*[=:]\s*["']?(https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)/g,
                /url:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/g,
                /'(https?:\/\/[^']+\.mp4[^']*)'/g,
                /"(https?:\/\/[^"]+\.mp4[^"]*)"/g,
            ];

            const found: string[] = [];
            const seen = new Set<string>();
            for (const pattern of patterns) {
                let m;
                const re = new RegExp(pattern.source, "g");
                while ((m = re.exec(html)) !== null) {
                    const u = m[1].replace(/\\/g, "");
                    if (!seen.has(u) && !u.includes("undefined") && !u.includes("null") && u.startsWith("http")) {
                        seen.add(u);
                        found.push(u);
                    }
                }
            }

            if (found.length === 0) continue;

            const primary = found[0];
            const cdnReferer =
                primary.includes("cfglobalcdn.com") || primary.includes("netu") || primary.includes("hqq")
                    ? "https://hqq.tv/"
                    : "https://tioanime.com/";

            return {
                url: primary,
                headers: {
                    Referer: cdnReferer,
                    Origin: cdnReferer.replace(/\/$/, ""),
                    "User-Agent": this.ua,
                },
            };
        }

        return { url: "error://extraction-failed" };
    }

    private async _watchOkru(embedUrl: string) {
        const html = await this._fetchText(embedUrl, { Referer: "https://tioanime.com" });
        if (!html) return { url: "error://extraction-failed" };

        const m = html.match(/"hlsMasterPlaylistUrl":"([^"]+)"/);
        if (m) return { url: m[1].replace(/\\/g, ""), headers: { Referer: "https://ok.ru/" } };

        const mp4 = html.match(/"mp4":\s*\[.*?"src":"([^"]+)"/s);
        if (mp4) return { url: mp4[1].replace(/\\/g, ""), headers: { Referer: "https://ok.ru/" } };

        return { url: "error://extraction-failed" };
    }

    private async _watchMp4Upload(embedUrl: string) {
        const html = await this._fetchText(embedUrl, { Referer: "https://tioanime.com" });
        if (!html) return { url: "error://extraction-failed" };

        const m = html.match(/src:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/);
        if (!m) return { url: "error://extraction-failed" };

        return { url: m[1], headers: { Referer: "https://www.mp4upload.com/" } };
    }

    private async _watchStreamtape(embedUrl: string) {
        const html = await this._fetchText(embedUrl, { Referer: "https://tioanime.com" });
        if (!html) return { url: "error://extraction-failed" };

        const m = html.match(/id="ideoooolink"[^>]*>([^<]+)<\/a>/);
        if (m) return { url: "https:" + m[1].trim(), headers: { Referer: "https://streamtape.com/" } };

        const m2 = html.match(/&token=[^&"]+&expires=[^"]+/);
        const base = html.match(/\/\/[^"]*streamtape[^/]+\/get_video\?/);
        if (m2 && base) {
            return { url: "https:" + base[0] + m2[0], headers: { Referer: "https://streamtape.com/" } };
        }

        return { url: "error://extraction-failed" };
    }
}
