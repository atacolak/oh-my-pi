/** Paired with --version so older images exit without entering a session. */
export const RESTART_RECEIVER_PROBE_ARG = "--restart-receiver-probe";
export const RESTART_RECEIVER_PROTOCOL = 1;

/** Advertises the exact-target, strict-owner receiver implemented by this image. */
export interface RestartReceiverProbe {
	type: "restart_receiver";
	protocol: typeof RESTART_RECEIVER_PROTOCOL;
	nonce: string;
	version: string;
}
