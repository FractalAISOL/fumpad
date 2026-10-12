import PrivacyPage from "@/app/privacy/page";
import s from "@/components/prelaunch/Room.module.css";

export { metadata } from "@/app/privacy/page";

/** /privacy on the pre-launch hosts: the same document, in the waiting room's frame. */
export default function RoomPrivacy() {
  return (
    <div className={s.legal}>
      <PrivacyPage />
    </div>
  );
}
