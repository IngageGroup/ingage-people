/** A calendar event as the chat's calendar tool returns it, in the user's time zone. */
export interface CalendarEvent {
  graphId: string;
  title: string;
  /** Local date in the user's zone, YYYY-MM-DD. */
  date: string;
  /** Local times, HH:MM. */
  start: string;
  end: string;
  /** Unrounded duration in hours. */
  hours: number;
  organizer: string;
  categories: string[];
}
