import TermsPage from "@/app/terms/page";
import s from "@/components/prelaunch/Room.module.css";

export { metadata } from "@/app/terms/page";

/** /terms on the pre-launch hosts: the same document, in the waiting room's frame. */
export default function RoomTerms() {
  return (
    <div className={s.legal}>
      <TermsPage />
    </div>
  );
}
