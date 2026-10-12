import RiskPage from "@/app/risk/page";
import s from "@/components/prelaunch/Room.module.css";

export { metadata } from "@/app/risk/page";

/** /risk on the pre-launch hosts: the same document, in the waiting room's frame. */
export default function RoomRisk() {
  return (
    <div className={s.legal}>
      <RiskPage />
    </div>
  );
}
