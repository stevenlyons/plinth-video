#ifndef PLINTH_CORE_H
#define PLINTH_CORE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Opaque handle to a plinth-core Session.
 * Only ever accessed via the functions below.
 */
typedef struct PlinthSession PlinthSession;

/**
 * Create a new session.
 *
 * @param config_json  JSON string matching the Config schema, or NULL for defaults.
 * @param meta_json    JSON string matching the SessionMeta schema.
 * @param now_ms       Current wall-clock time in milliseconds.
 * @return             Opaque session pointer, or NULL on parse error.
 *                     Caller owns the pointer; free with plinth_session_destroy.
 */
PlinthSession* plinth_session_new(const char* config_json,
                                   const char* meta_json,
                                   uint64_t now_ms);

/**
 * Process a player event.
 *
 * @param session    Session pointer from plinth_session_new.
 * @param event_json JSON string matching the PlayerEvent schema.
 * @param now_ms     Current wall-clock time in milliseconds.
 * @return           Heap-allocated JSON string {"beacons":[...]}.
 *                   Caller MUST free with plinth_free_string.
 */
char* plinth_session_process_event(PlinthSession* session,
                                    const char* event_json,
                                    uint64_t now_ms);

/**
 * Heartbeat tick. Call on a regular interval; the core decides whether to emit.
 *
 * @param session  Session pointer.
 * @param now_ms   Current wall-clock time in milliseconds.
 * @return         Heap-allocated JSON string {"beacons":[...]}.
 *                 Caller MUST free with plinth_free_string.
 */
char* plinth_session_tick(PlinthSession* session, uint64_t now_ms);

/**
 * Update the platform-reported playhead position (used in heartbeat beacons).
 *
 * @param session     Session pointer.
 * @param playhead_ms Playhead position in milliseconds.
 */
void plinth_session_set_playhead(PlinthSession* session, uint64_t playhead_ms);

/**
 * Destroy the session and emit any final beacons.
 *
 * Frees the session pointer — do not use it after this call.
 *
 * @param session  Session pointer.
 * @param now_ms   Current wall-clock time in milliseconds.
 * @return         Heap-allocated JSON string {"beacons":[...]}.
 *                 Caller MUST free with plinth_free_string.
 */
char* plinth_session_destroy(PlinthSession* session, uint64_t now_ms);

/**
 * Free a string returned by any plinth_session_* function.
 * Passing NULL is a no-op.
 */
void plinth_free_string(char* ptr);

#ifdef __cplusplus
}
#endif

#endif /* PLINTH_CORE_H */
