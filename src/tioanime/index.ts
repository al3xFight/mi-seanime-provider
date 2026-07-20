/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts" />

class Provider {
    baseUrl = "https://tioanime.com";

    // 1. Configuración del plugin
    getSettings(): Settings {
        return {
            // Nombre de los servidores que TioAnime suele usar (Fembed, Mega, YourUpload, Streamtape, etc.)
            episodeServers: ["Mega", "Yourupload", "Maru", "Bembed"],
            supportsDub: false, // TioAnime es principalmente subtitulado
        };
    }

    // 2. Búsqueda de Anime
    async search(opts: SearchOptions): Promise<SearchResult[]> {
        // Haces la petición al buscador de TioAnime
        const req = await fetch(`${this.baseUrl}/directorio?q=${encodeURIComponent(opts.query)}`);
        if (!req.ok) return [];

        const html = await req.text();
        const $ = LoadDoc(html); // Helper DOM nativo de Seanime
        const results: SearchResult[] = [];

        // Extraes el listado de la búsqueda (adaptando el selector CSS de TioAnime)
        $("ul.animes li").each((_, el) => {
            const link = el.find("a").attr("href");
            const title = el.find("h3.title").text();
            
            if (link && title) {
                results.push({
                    id: link, // Guardamos la ruta relativa, ej: "/anime/naruto"
                    title: title.trim(),
                    url: `${this.baseUrl}${link}`,
                    subOrDub: "sub",
                });
            }
        });

        return results;
    }

    // 3. Obtener la lista de episodios
    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        // Petición a la página principal del anime
        const req = await fetch(`${this.baseUrl}${id}`);
        const html = await req.text();

        const episodes: EpisodeDetails[] = [];

        /*
           TioAnime guarda los episodios en un script JS dentro de la página:
           var anime_info = ["4020", "naruto", "naruto"];
           var episodes = [[1, 1], [2, 2], ...];
        */
        const animeInfoMatch = html.match(/var anime_info = \[(.+?)\];/);
        const episodesMatch = html.match(/var episodes = \[(.+?)\];/);

        if (episodesMatch && animeInfoMatch) {
            const animeSlug = JSON.parse(`[${animeInfoMatch[1]}]`)[1];
            const rawEpisodes = JSON.parse(`[${episodesMatch[1]}]`);

            // Mapeamos los episodios
            for (const ep of rawEpisodes) {
                const epNum = ep[0];
                episodes.push({
                    // ID formateado para identificar el episodio después
                    id: `/ver/${animeSlug}-${epNum}`, 
                    number: epNum,
                    title: `Episodio ${epNum}`,
                    url: `${this.baseUrl}/ver/${animeSlug}-${epNum}`,
                });
            }
        }

        return episodes.reverse(); // Para ordenar del episodio 1 en adelante
    }

    // 4. Extraer los servidores y enlaces de video
    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        const req = await fetch(`${this.baseUrl}${episode.id}`);
        const html = await req.text();

        /*
           TioAnime guarda las URLs de los iFrames/reproductores en una variable JS:
           var videos = [["Mega","https://mega.nz/embed/..."], ["Yourupload","https://..."]];
        */
        const videosMatch = html.match(/var videos = (\[.+?\]);/);
        
        if (!videosMatch) {
            throw new Error("No se encontraron reproductores de video.");
        }

        const videosData: [string, string][] = JSON.parse(videosMatch[1]);
        
        const result: EpisodeServer = {
            server: _server !== "default" ? _server : "TioAnime",
            headers: {
                "Referer": this.baseUrl,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
            },
            videoSources: []
        };

        // Recorremos los reproductores encontrados en el script de TioAnime
        for (const [serverName, embedUrl] of videosData) {
            
            // Si el usuario seleccionó un servidor específico y no coincide, pasamos al siguiente
            if (_server !== "default" && serverName.toLowerCase() !== _server.toLowerCase()) {
                continue;
            }

            /* 
               AQUÍ ADAPTAS LA EXTRACCIÓN DEL REPRODUCTOR ESPECÍFICO:
               Muchos servidores (como Fembed, Mega, YourUpload) entregan un iFrame.
               Si el embedUrl da directo a un m3u8/mp4 o requiere desempaquetar JS, 
               extraes el link final aquí.
            */

            result.videoSources.push({
                url: embedUrl, // URL del embed o m3u8 extraído
                type: embedUrl.includes(".m3u8") ? "m3u8" : "unknown",
                quality: `720p/1080p - ${serverName}`,
                subtitles: []
            });
        }

        return result;
    }
}
