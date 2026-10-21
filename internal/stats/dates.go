package stats

import "time"

// GetTodayDate returns today's date as YYYY-MM-DD.
func GetTodayDate() string {
	return time.Now().Format("2006-01-02")
}

// GetYesterdayDate returns yesterday's date as YYYY-MM-DD.
func GetYesterdayDate() string {
	return time.Now().AddDate(0, 0, -1).Format("2006-01-02")
}

// DaysBefore returns the YYYY-MM-DD date n days before the given date.
// An unparsable date is returned unchanged, so a caller with a bad input
// degrades to "the same day" rather than to an arbitrary date.
func DaysBefore(date string, n int) string {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return date
	}
	return t.AddDate(0, 0, -n).Format("2006-01-02")
}

// IsWorkday reports whether the given YYYY-MM-DD date falls on a weekday.
func IsWorkday(date string) bool {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return true
	}
	day := t.Weekday()
	return day != time.Saturday && day != time.Sunday
}
