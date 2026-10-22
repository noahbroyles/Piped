// Connects googlevideo's SabrStreamingAdapter to Shaka Player.
//
// Ported from googlevideo's Shaka example (examples/sabr-shaka-example, MIT, (c) LuanRT) as of
// googlevideo 4.1.1, with these changes for Piped:
// - Shaka is passed in, since the player loads it lazily.
// - dispose() puts Shaka's own HTTP plugin back, since the same Shaka player keeps playing
//   regular (non SABR) videos afterwards.
// - It also handles sabr:// itself and keeps each request's original sabr:// URI, both needed
//   with Shaka 5 (see below).
// - Each response only yields the segment that was asked for (see SingleSegmentUmpProcessor).
import { FormatKeyUtils, isGoogleVideoURL } from "googlevideo/utils";
import { SabrUmpProcessor } from "googlevideo/sabr-streaming-adapter";

const HTTP_SCHEMES = ["http", "https"];

// Shaka 5 picks the plugin for a request by the scheme of its URI *before* the request filters
// run, then calls that plugin with the filtered URI. The adapter's filter turns sabr:// into an
// HTTP(S) URL, so sabr:// needs a plugin too, which then gets the HTTP(S) URL to fetch.
const SABR_SCHEME = "sabr";

function headersToObject(headers) {
    const result = {};
    // Edge used to prefix header names with a newline, hence the trim
    headers.forEach((value, key) => (result[key.trim()] = value));
    return result;
}

// googlevideo often sends more segments than the one asked for, e.g. the first media segment
// along with an init segment. Its processor hands over the first one, but keeps reading the rest
// of the network chunk, and each segment it finishes there overwrites the media header it reports
// for the request. The adapter then believes that later segment was received and tells the server
// it is buffered, so the server skips the segments before it. The first audio segment went missing
// that way, and Shaka jumped over the gap, starting the video 5 to 10 seconds in.
// So once the segment for the request is done, the rest of the response's media is ignored.
class SingleSegmentUmpProcessor extends SabrUmpProcessor {
    handleMediaHeader(part) {
        return this.segmentDone ? undefined : super.handleMediaHeader(part);
    }

    handleMedia(part) {
        return this.segmentDone ? undefined : super.handleMedia(part);
    }

    handleMediaEnd(part) {
        if (this.segmentDone) return undefined;
        const result = super.handleMediaEnd(part);
        if (result) this.segmentDone = true;
        return result;
    }
}

export class SabrPlayerAdapter {
    // onForbidden: called when googlevideo refuses a SABR request (401 or 403). Shaka would only
    // keep switching between formats that all fail the same way, so the caller has to step in.
    // onUnattested: called with the status when googlevideo reports the stream's attestation as
    // pending (2) or required (3). It then only serves the first minute, or nothing at all.
    constructor(shaka, onForbidden, onUnattested) {
        this.shaka = shaka;
        this.onForbidden = onForbidden;
        this.onUnattested = onUnattested;
        this.player = null;
        this.requestMetadataManager = null;
        this.cacheManager = null;
        this.abortController = null;
        this.requestFilter = null;
        this.responseFilter = null;
    }

    // Called by SabrStreamingAdapter.attach()
    initialize(player, requestMetadataManager, cacheManager) {
        const shaka = this.shaka;
        this.player = player;
        this.requestMetadataManager = requestMetadataManager;
        this.cacheManager = cacheManager;

        if (!shaka.net.HttpFetchPlugin.isSupported())
            throw new Error("The Fetch API is not supported in this browser.");

        // Take over HTTP(S) in Shaka, so UMP responses can be unpacked as they stream in
        for (const scheme of [...HTTP_SCHEMES, SABR_SCHEME]) {
            shaka.net.NetworkingEngine.registerScheme(
                scheme,
                this.parseRequest.bind(this),
                shaka.net.NetworkingEngine.PluginPriority.PREFERRED,
            );
        }
    }

    makeRecoverableError(message, info) {
        const { Error: ShakaError } = this.shaka.util;
        return new ShakaError(
            ShakaError.Severity.RECOVERABLE,
            ShakaError.Category.NETWORK,
            ShakaError.Code.HTTP_ERROR,
            message,
            { info },
        );
    }

    makeResponse(headers, data, status, uri, responseURL, request, requestType) {
        if (status >= 200 && status <= 299 && status !== 202) {
            return {
                uri: responseURL || uri,
                originalUri: uri,
                data,
                status,
                headers,
                originalRequest: request,
                fromCache: !!headers["x-shaka-from-cache"],
            };
        }

        let responseText = null;
        try {
            responseText = this.shaka.util.StringUtils.fromBytesAutoDetect(data);
        } catch {
            // not text, never mind
        }

        const { Error: ShakaError } = this.shaka.util;
        // A 401 or 403 won't fix itself by retrying
        const severity =
            status === 401 || status === 403 ? ShakaError.Severity.CRITICAL : ShakaError.Severity.RECOVERABLE;

        throw new ShakaError(
            severity,
            ShakaError.Category.NETWORK,
            ShakaError.Code.BAD_HTTP_STATUS,
            uri,
            status,
            responseText,
            headers,
            requestType,
            responseURL || uri,
        );
    }

    createShakaResponse({ uri, request, requestType, response, arrayBuffer }) {
        return this.makeResponse(
            headersToObject(response.headers),
            arrayBuffer || new ArrayBuffer(0),
            response.status,
            uri,
            response.url,
            request,
            requestType,
        );
    }

    // Shaka scheme plugin: performs every HTTP(S) request the player makes
    parseRequest(uri, request, requestType, progressUpdated, headersReceived, config) {
        const shaka = this.shaka;
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) headers.append(key, value);

        const controller = new AbortController();
        this.abortController = controller;

        const init = {
            body: request.body || undefined,
            headers,
            method: request.method,
            signal: controller.signal,
            credentials: request.allowCrossSiteCredentials ? "include" : undefined,
        };

        const abortStatus = { canceled: false, timedOut: false };
        const minBytes = config.minBytesForProgressEvents || 0;

        const pendingRequest = this.request(
            uri,
            request,
            requestType,
            init,
            controller,
            abortStatus,
            progressUpdated,
            headersReceived,
            minBytes,
        );

        const operation = new shaka.util.AbortableOperation(pendingRequest, () => {
            abortStatus.canceled = true;
            controller.abort();
            return Promise.resolve();
        });

        const timeoutMs = request.retryParameters.timeout;
        if (timeoutMs) {
            const timer = new shaka.util.Timer(() => {
                abortStatus.timedOut = true;
                controller.abort();
            });
            timer.tickAfter(timeoutMs / 1000);
            operation.finally(() => timer.stop());
        }

        return operation;
    }

    // Serves a segment that an earlier UMP response already delivered, if we have it
    handleCachedRequest(requestMetadata, uri, request, progressUpdated, headersReceived, requestType) {
        if (!requestMetadata.byteRange || !this.cacheManager) return null;

        const segmentKey = FormatKeyUtils.createSegmentCacheKeyFromMetadata(requestMetadata);
        let arrayBuffer = (
            requestMetadata.isInit
                ? this.cacheManager.getInitSegment(segmentKey)
                : this.cacheManager.getSegment(segmentKey)
        )?.buffer;

        if (!arrayBuffer) return null;

        if (requestMetadata.isInit) {
            arrayBuffer = arrayBuffer.slice(requestMetadata.byteRange.start, requestMetadata.byteRange.end + 1);
        }

        const headers = {
            "content-type": requestMetadata.format?.mimeType?.split(";")[0] || "",
            "content-length": arrayBuffer.byteLength.toString(),
            "x-shaka-from-cache": "true",
        };

        headersReceived(headers);
        progressUpdated(0, arrayBuffer.byteLength, 0);

        return this.makeResponse(headers, arrayBuffer, 200, uri, uri, request, requestType);
    }

    // Unpacks a UMP response into the one media segment Shaka asked for
    async handleUmpResponse(
        response,
        requestMetadata,
        uri,
        request,
        requestType,
        progressUpdated,
        abortController,
        minBytes,
    ) {
        let lastTime = Date.now();
        const umpProcessor = new SingleSegmentUmpProcessor(requestMetadata, this.cacheManager);

        const checkResultIntegrity = result => {
            if (
                !result.data &&
                (!!requestMetadata.error || requestMetadata.streamInfo?.streamProtectionStatus?.status === 3) &&
                !requestMetadata.streamInfo?.sabrContextUpdate
            ) {
                throw this.makeRecoverableError("Server streaming error", requestMetadata);
            }
        };

        // googlevideo puts the stream protection status in (nearly) every response
        const checkStreamProtection = () => {
            const status = requestMetadata.streamInfo?.streamProtectionStatus?.status;
            if (requestMetadata.isSABR && (status === 2 || status === 3)) this.onUnattested?.(status);
        };

        // A redirect or context update comes without media; the adapter then retries on its own
        const shouldReturnEmptyResponse = () =>
            requestMetadata.isSABR &&
            (requestMetadata.streamInfo?.redirect || requestMetadata.streamInfo?.sabrContextUpdate);

        // Without streamed bodies, wait for the whole response
        if (!response.body) {
            const arrayBuffer = await response.arrayBuffer();
            progressUpdated(Date.now() - lastTime, arrayBuffer.byteLength, 0);

            const result = await umpProcessor.processChunk(new Uint8Array(arrayBuffer));
            checkStreamProtection();
            if (result) {
                checkResultIntegrity(result);
                return this.createShakaResponse({ uri, request, requestType, response, arrayBuffer: result.data });
            }
            if (shouldReturnEmptyResponse()) {
                return this.createShakaResponse({ uri, request, requestType, response });
            }
            throw this.makeRecoverableError("Empty response with no redirect information", requestMetadata);
        }

        const reader = response.body.getReader();
        let loaded = 0;
        let lastLoaded = 0;
        let contentLength;

        while (!abortController.signal.aborted) {
            let chunk;
            try {
                chunk = await reader.read();
            } catch {
                // Reading an aborted request throws; that's expected
                break;
            }

            const { value, done } = chunk;

            if (done) {
                // The whole response held no segment: follow a redirect or protocol update
                if (shouldReturnEmptyResponse()) {
                    return this.createShakaResponse({ uri, request, requestType, response });
                }
                throw this.makeRecoverableError("Empty response with no redirect information", requestMetadata);
            }

            const result = await umpProcessor.processChunk(value);
            checkStreamProtection();
            const segmentInfo = umpProcessor.getSegmentInfo();

            if (segmentInfo) {
                if (!contentLength) contentLength = segmentInfo.mediaHeader.contentLength;
                loaded += segmentInfo.lastChunkSize || 0;
                segmentInfo.lastChunkSize = 0;
            }

            const currentTime = Date.now();
            const chunkSize = loaded - lastLoaded;

            // Report progress now and then (Shaka's bandwidth estimate depends on it)
            if ((currentTime - lastTime > 100 && chunkSize >= minBytes) || result) {
                if (result) checkResultIntegrity(result);
                if (contentLength) {
                    const numBytesRemaining = result ? 0 : parseInt(contentLength) - loaded;
                    try {
                        progressUpdated(currentTime - lastTime, chunkSize, numBytesRemaining);
                    } catch {
                        // Shaka may have given up on this request already
                    } finally {
                        lastLoaded = loaded;
                        lastTime = currentTime;
                    }
                }
            }

            if (result) {
                abortController.abort();
                return this.createShakaResponse({ uri, request, requestType, response, arrayBuffer: result.data });
            }
        }

        throw this.makeRecoverableError(
            "UMP stream processing was aborted but did not produce a result.",
            requestMetadata,
        );
    }

    async request(
        uri,
        request,
        requestType,
        init,
        abortController,
        abortStatus,
        progressUpdated,
        headersReceived,
        minBytes,
    ) {
        const { Error: ShakaError } = this.shaka.util;
        try {
            const requestMetadata = this.requestMetadataManager?.getRequestMetadata(uri);

            if (requestMetadata) {
                const cached = this.handleCachedRequest(
                    requestMetadata,
                    uri,
                    request,
                    progressUpdated,
                    headersReceived,
                    requestType,
                );
                if (cached) return cached;
            }

            const response = await fetch(uri, init);
            headersReceived(headersToObject(response.headers));

            if (requestMetadata?.isSABR && (response.status === 401 || response.status === 403)) {
                this.onForbidden?.(response.status);
            }

            if (
                requestMetadata &&
                init.method !== "HEAD" &&
                response.headers.get("content-type") === "application/vnd.yt-ump"
            ) {
                return await this.handleUmpResponse(
                    response,
                    requestMetadata,
                    uri,
                    request,
                    requestType,
                    progressUpdated,
                    abortController,
                    minBytes,
                );
            }

            // Anything else (manifests, subtitles, thumbnails...) is a plain request
            const lastTime = Date.now();
            const arrayBuffer = await response.arrayBuffer();
            progressUpdated(Date.now() - lastTime, arrayBuffer.byteLength, 0);

            return this.createShakaResponse({ uri, request, requestType, response, arrayBuffer });
        } catch (error) {
            // Errors we raised ourselves already say what went wrong
            if (error instanceof ShakaError) throw error;

            if (abortStatus.canceled) {
                throw new ShakaError(
                    ShakaError.Severity.RECOVERABLE,
                    ShakaError.Category.NETWORK,
                    ShakaError.Code.OPERATION_ABORTED,
                    uri,
                    requestType,
                );
            } else if (abortStatus.timedOut) {
                throw new ShakaError(
                    ShakaError.Severity.RECOVERABLE,
                    ShakaError.Category.NETWORK,
                    ShakaError.Code.TIMEOUT,
                    uri,
                    requestType,
                );
            }
            throw new ShakaError(
                ShakaError.Severity.RECOVERABLE,
                ShakaError.Category.NETWORK,
                ShakaError.Code.HTTP_ERROR,
                uri,
                error,
                requestType,
            );
        }
    }

    checkPlayerStatus() {
        if (!this.player) throw new Error("Player not initialized");
    }

    getPlayerTime() {
        this.checkPlayerStatus();
        return this.player.getMediaElement()?.currentTime || 0;
    }

    getPlaybackRate() {
        this.checkPlayerStatus();
        return this.player.getPlaybackRate();
    }

    getBandwidthEstimate() {
        this.checkPlayerStatus();
        return this.player.getStats().estimatedBandwidth;
    }

    // Finds the formats playing now; the manifest's representation IDs are their unique format IDs
    getActiveTrackFormats(activeFormat, sabrFormats) {
        this.checkPlayerStatus();

        const activeId = FormatKeyUtils.getUniqueFormatId(activeFormat);
        const activeVariant = this.player
            .getVariantTracks()
            .find(track => activeId === (activeFormat.width ? track.originalVideoId : track.originalAudioId));

        if (!activeVariant) return { videoFormat: undefined, audioFormat: undefined };

        const formatMap = new Map(sabrFormats.map(format => [FormatKeyUtils.getUniqueFormatId(format), format]));

        return {
            videoFormat: activeVariant.originalVideoId ? formatMap.get(activeVariant.originalVideoId) : undefined,
            audioFormat: activeVariant.originalAudioId ? formatMap.get(activeVariant.originalAudioId) : undefined,
        };
    }

    registerRequestInterceptor(interceptor) {
        this.checkPlayerStatus();
        const shaka = this.shaka;
        const networkingEngine = this.player.getNetworkingEngine();
        if (!networkingEngine) return;

        this.requestFilter = async (type, request, context) => {
            // Shaka runs the filters again on every retry, with the URI the last run left behind.
            // Start each run from the original sabr:// URI, or the adapter would take the
            // streaming URL from the last run for a plain (non SABR) request.
            const uri = request.sabrUri ?? request.uris[0];
            if (type !== shaka.net.NetworkingEngine.RequestType.SEGMENT || !isGoogleVideoURL(uri)) return;
            if (uri.startsWith(`${SABR_SCHEME}:`)) request.sabrUri = uri;

            const modifiedRequest = await interceptor({
                headers: request.headers,
                url: uri,
                method: request.method,
                segment: {
                    getStartTime: () => context?.segment?.getStartTime() ?? null,
                    isInit: () => !context?.segment,
                },
                body: request.body,
            });

            if (modifiedRequest) {
                request.uris = modifiedRequest.url ? [modifiedRequest.url] : request.uris;
                request.method = modifiedRequest.method || request.method;
                request.headers = modifiedRequest.headers || request.headers;
                request.body = modifiedRequest.body || request.body;
            }
        };

        networkingEngine.registerRequestFilter(this.requestFilter);
    }

    registerResponseInterceptor(interceptor) {
        this.checkPlayerStatus();
        const shaka = this.shaka;
        const networkingEngine = this.player.getNetworkingEngine();
        if (!networkingEngine) return;

        this.responseFilter = async (type, response, context) => {
            if (type !== shaka.net.NetworkingEngine.RequestType.SEGMENT || !isGoogleVideoURL(response.uri)) return;

            const modifiedResponse = await interceptor({
                url: response.originalRequest.uris[0],
                method: response.originalRequest.method,
                headers: response.headers,
                data: response.data,
                // Lets the adapter retry or follow a redirect through Shaka
                makeRequest: async (url, headers) => {
                    const retryParameters = this.player.getConfiguration().streaming.retryParameters;
                    const redirectRequest = shaka.net.NetworkingEngine.makeRequest([url], retryParameters);
                    Object.assign(redirectRequest.headers, headers);

                    const redirectResponse = await networkingEngine.request(type, redirectRequest, context).promise;

                    return {
                        url: redirectResponse.uri,
                        method: redirectResponse.originalRequest.method,
                        headers: redirectResponse.headers,
                        data: redirectResponse.data,
                    };
                },
            });

            if (modifiedResponse) {
                response.data = modifiedResponse.data ?? response.data;
                Object.assign(response.headers, modifiedResponse.headers);
            }
        };

        networkingEngine.registerResponseFilter(this.responseFilter);
    }

    dispose() {
        const shaka = this.shaka;

        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }

        if (this.player) {
            const networkingEngine = this.player.getNetworkingEngine();
            if (networkingEngine) {
                if (this.requestFilter) networkingEngine.unregisterRequestFilter(this.requestFilter);
                if (this.responseFilter) networkingEngine.unregisterResponseFilter(this.responseFilter);
            }
            this.player = null;
        }

        // Nothing but this adapter can fetch sabr:// URIs
        shaka.net.NetworkingEngine.unregisterScheme(SABR_SCHEME);

        // Unregistering would leave Shaka with no HTTP plugin at all, so hand HTTP back to Shaka's own
        for (const scheme of HTTP_SCHEMES) {
            shaka.net.NetworkingEngine.registerScheme(
                scheme,
                shaka.net.HttpFetchPlugin.parse,
                shaka.net.NetworkingEngine.PluginPriority.PREFERRED,
            );
        }
    }
}
