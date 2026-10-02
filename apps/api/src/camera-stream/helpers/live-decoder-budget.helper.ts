import { envNumber } from '../../common/config/env-number.helper';

/** Input decoding has its own thread setting: output -threads only limits the
 * encoder. FFmpeg auto-sizing otherwise creates dozens of decoder threads for
 * each camera, even when the encoder is already bounded. */
export function liveDecoderInputArgs(env: Record<string, string | undefined> = process.env): string {
  const threads = envNumber('LIVE_CAPTURE_DECODER_THREADS', 2,
    { min: 1, max: 16, integer: true }, env);
  const filters = envNumber('LIVE_CAPTURE_FILTER_THREADS', 1,
    { min: 1, max: 8, integer: true }, env);
  return `-threads ${threads} -filter_threads ${filters}`;
}
