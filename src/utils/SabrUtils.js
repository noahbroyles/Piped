// Plays YouTube's SABR streams with Shaka, using what the backend puts in /streams as `sabr`.
//
// With SABR, the player doesn't fetch byte ranges from a URL per format. It POSTs its playback
// state to one streaming URL and gets back whatever segments the server picks, so googlevideo's
// SabrStreamingAdapter sits between Shaka and the network. The manifest only lists the formats,
// each with a sabr:// placeholder URL that the adapter swaps for the real request.
import { SabrStreamingAdapter } from "googlevideo/sabr-streaming-adapter";
import { buildSabrFormat, FormatKeyUtils } from "googlevideo/utils";
import { generate_dash_file_from_formats } from "./DashUtils.js";
import { SabrPlayerAdapter } from "./SabrPlayerAdapter.js";

// Formats a DASH manifest can describe: ones with init and index ranges (so not OTF or live),
// and no DRC audio, which would share the itag of the regular track
function isUsableFormat(format) {
    return format.mimeType && format.initRange && format.indexRange && !format.isDrc;
}

/**
 * Builds a DASH manifest (as a data URI) for the formats in `sabr`.
 */
export function generateSabrManifestUri(sabr, duration) {
    const streams = sabr.formats.filter(isUsableFormat).map(format => {
        const sabrFormat = buildSabrFormat(format);
        const isVideo = format.mimeType.startsWith("video/");
        // "video/mp4; codecs=\"avc1.4d401e\"" -> "video/mp4" and "avc1.4d401e"
        const [mimeType, codecsPart] = format.mimeType.split(";");
        const codec = codecsPart?.split("=")[1]?.replaceAll('"', "").trim();

        return {
            // The adapter matches Shaka's tracks to formats by this ID
            itag: FormatKeyUtils.getUniqueFormatId(sabrFormat),
            url: `sabr://${isVideo ? "video" : "audio"}?key=${FormatKeyUtils.fromFormat(sabrFormat)}`,
            mimeType: mimeType.trim(),
            codec,
            videoOnly: isVideo,
            bitrate: format.bitrate,
            width: format.width,
            height: format.height,
            fps: format.fps,
            audioTrackId: format.audioTrack?.id,
            initStart: format.initRange.start,
            initEnd: format.initRange.end,
            indexStart: format.indexRange.start,
            indexEnd: format.indexRange.end,
        };
    });

    const dash = generate_dash_file_from_formats(streams, duration);
    return "data:application/dash+xml;charset=utf-8;base64," + btoa(dash);
}

/**
 * Hooks a SABR adapter into `player` for the video described by `sabr`.
 *
 * @param reloadSabr called when YouTube asks for a fresh player response; resolves to new `sabr` info
 * @param onFailure called once if googlevideo keeps refusing the stream, even with fresh SABR info
 * @returns the adapter, to be disposed of before the player loads anything else
 */
export function attachSabrAdapter(shaka, player, sabr, reloadSabr, onFailure) {
    let current = sabr;
    let state = "ok"; // then "refreshing", "refreshed" or "failed"

    const useSabrInfo = info => {
        current = info;
        adapter.setStreamingURL(info.serverAbrStreamingUrl);
        adapter.setUstreamerConfig(info.videoPlaybackUstreamerConfig);
    };

    // A refused request most likely means the streaming URL expired, so get a fresh one first.
    // If even that is refused, SABR isn't going to work for this video.
    const onForbidden = () => {
        if (state === "ok") {
            state = "refreshing";
            reloadSabr()
                .then(info => {
                    if (!info) throw new Error("No SABR info after reloading the video");
                    useSabrInfo(info);
                    state = "refreshed";
                })
                .catch(e => {
                    console.warn("Could not refresh the SABR streaming URL", e);
                    state = "failed";
                    onFailure();
                });
        } else if (state === "refreshed") {
            state = "failed";
            onFailure();
        }
    };

    const adapter = new SabrStreamingAdapter({
        playerAdapter: new SabrPlayerAdapter(shaka, onForbidden),
        clientInfo: {
            clientName: sabr.clientName,
            clientVersion: sabr.clientVersion,
        },
    });

    // The backend mints a PoToken bound to this video; googlevideo sends it with every request
    adapter.onMintPoToken(async () => current.poToken || "");

    // YouTube sometimes wants the streaming URL refreshed, e.g. when it expires
    adapter.onReloadPlayerResponse(async () => {
        const fresh = await reloadSabr();
        if (!fresh) throw new Error("No SABR info after reloading the video");
        useSabrInfo(fresh);
    });

    adapter.attach(player);
    adapter.setStreamingURL(sabr.serverAbrStreamingUrl);
    adapter.setUstreamerConfig(sabr.videoPlaybackUstreamerConfig);
    adapter.setServerAbrFormats(sabr.formats.filter(isUsableFormat).map(buildSabrFormat));

    return adapter;
}
