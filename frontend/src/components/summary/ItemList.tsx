import type { ReactNode } from "react";
import type { Sourced } from "../../types/w1-sum";
import { SourceChips } from "./EvidenceChip";

/** A heading, or nothing at all when the list is empty. */
export function Block({
  title,
  count,
  sub = false,
  children,
}: {
  title: string;
  count: number;
  sub?: boolean;
  children: ReactNode;
}) {
  // An empty section is a correct answer, not something to print.
  if (count === 0) return null;

  if (sub) {
    return (
      <div>
        <h4 className="sum-subhead">{title}</h4>
        {children}
      </div>
    );
  }

  return (
    <section className="summary-section">
      <h3>
        {title}
        <span className="section-count">{count}</span>
      </h3>
      {children}
    </section>
  );
}

/** Evidence-backed items, each with its speaker/time chips. */
export function ItemList<T extends Sourced>({
  items,
  render,
}: {
  items: T[];
  render: (item: T) => ReactNode;
}) {
  return (
    <ul className="clean-list">
      {items.map((item, index) => (
        <li key={index} className="sum-item">
          <span className="sum-item-text">{render(item)}</span>
          <SourceChips item={item} />
        </li>
      ))}
    </ul>
  );
}

/** Heading + list in one, for the common case. */
export function ItemBlock<T extends Sourced>({
  title,
  items,
  render,
  sub,
}: {
  title: string;
  items: T[];
  render: (item: T) => ReactNode;
  sub?: boolean;
}) {
  return (
    <Block title={title} count={items.length} sub={sub}>
      <ItemList items={items} render={render} />
    </Block>
  );
}
