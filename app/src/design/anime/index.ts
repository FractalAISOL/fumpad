/**
 * FUMPAD anime kit (web): Fumi + anime effects on top of the Signal design system.
 * LOCKED for phase-2 agents: import, don't edit. Rules: marketing/STYLE-ANIME.md.
 *
 *   import { Fumi, SpeechBubble, FumiEmptyState } from "@/design/anime";
 */
export { Fumi, FUMI_SIZE } from "./Fumi";
export type { FumiProps, FumiSize } from "./Fumi";
export { SpeechBubble } from "./SpeechBubble";
export type { BubbleTail } from "./SpeechBubble";
export { Sparkles, Bang, SweatDrop, SpeedLines, PopIn } from "./effects";
export { FumiEmptyState, FumiErrorState, FumiLoadingState } from "./FumiStates";
export { FUMI_POSES, FUMI_POSE_KEYS, REF_HEAD, drawnPose, hasArt } from "./poses";
export type { FumiPose, FumiFx, FumiPoseInfo } from "./poses";
