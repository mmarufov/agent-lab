// Reveal a record inside one scroll area without scrolling its ancestors.
export function revealWithin(
  container: HTMLElement,
  target: HTMLElement,
  align: "nearest" | "start" = "nearest",
) {
  const top =
    target.getBoundingClientRect().top -
    container.getBoundingClientRect().top -
    container.clientTop +
    container.scrollTop;
  const bottom = top + target.offsetHeight;
  const next =
    align === "start" ||
    top < container.scrollTop ||
    target.offsetHeight > container.clientHeight
      ? top
      : bottom > container.scrollTop + container.clientHeight
        ? bottom - container.clientHeight
        : container.scrollTop;
  container.scrollTo({ top: next, behavior: "instant" });
}
