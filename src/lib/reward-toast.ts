import { toast, type ExternalToast } from "sonner";

/** The gold "you EARNED this" toast — KA-CHING, lead submitted, clock-in,
 *  lead confirmed. Styling lives in `.reward-toast` (styles.css, sonner
 *  reskin section); everything informational keeps plain sonner so the
 *  reward look stays scarce. Buzzes by default — pass `vibrate: false`
 *  when the caller already fired its own haptic. */
export function rewardToast(
  title: string,
  opts?: ExternalToast & { vibrate?: number[] | false },
) {
  const { vibrate = [30, 80, 30], ...rest } = opts ?? {};
  if (vibrate) {
    try {
      navigator.vibrate?.(vibrate);
    } catch {
      /* unsupported */
    }
  }
  return toast(title, { className: "reward-toast", duration: 5000, ...rest });
}
