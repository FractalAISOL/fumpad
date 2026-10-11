import { Loading, Panel, Skeleton } from "@/design";
import s from "./Coin.module.css";

/** Same geometry as the coin page, so nothing shifts when it streams in. */
export function CoinSkeleton() {
  return (
    <div className="wrap">
      <Loading label="Loading coin">
        <div className={s.head}>
          <Skeleton w={56} h={56} />
          <div>
            <Skeleton w="min(320px, 60vw)" h={30} />
            <div style={{ height: 8 }} />
            <Skeleton w="min(420px, 70vw)" h={13} />
          </div>
        </div>
        <div className={s.grid}>
          <Panel as="div">
            <div className={s.chartBox} style={{ padding: 16 }}>
              <Skeleton h="100%" />
            </div>
          </Panel>
          <Panel as="div">
            <div style={{ padding: 16, display: "grid", gap: 12 }}>
              <Skeleton h={36} />
              <Skeleton h={56} />
              <Skeleton h={120} />
              <Skeleton h={48} />
            </div>
          </Panel>
        </div>
      </Loading>
    </div>
  );
}
