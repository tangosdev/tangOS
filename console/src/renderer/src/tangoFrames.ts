import idle from './assets/tango-idle.png'
import handsup from './assets/tango-hands-up.png'
import thinking from './assets/tango-thinking.png'
import shy from './assets/tango-shy.png'
import smile from './assets/tango-smile.png'
import tongue from './assets/tango-tongue.png'

/** Emotion name -> mascot frame. Referenced by name (in tips + tour steps). */
export const TANGO_FRAMES: Record<string, string> = {
  idle,
  handsup,
  'hands-up': handsup,
  excited: handsup,
  thinking,
  shy,
  smile,
  happy: smile,
  tongue,
  playful: tongue,
  silly: tongue
}

/** Resolve an emotion name to a frame; falls back to a friendly smile. */
export function frame(name?: string): string {
  return (name ? TANGO_FRAMES[name.toLowerCase()] : undefined) ?? smile
}

/** Every distinct pose, for a random pick (e.g. the splash shows a fresh one each swap). */
export const TANGO_POSES = [idle, handsup, thinking, shy, smile, tongue]

/** A random pose each call. */
export function randomPose(): string {
  return TANGO_POSES[Math.floor(Math.random() * TANGO_POSES.length)]
}
