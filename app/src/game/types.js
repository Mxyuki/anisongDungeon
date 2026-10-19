/**
 * Shared shape definitions (JSDoc only, no runtime code).
 *
 * @typedef {'OP' | 'ED' | 'IN'} SongType
 *
 * @typedef {object} Anime
 * @property {number} id            Library id (ANN id).
 * @property {number} aniListId     0 when unknown.
 * @property {string} displayName
 * @property {string[]} names       Every accepted name.
 * @property {string[]} genres
 * @property {string[]} tags
 * @property {number} season        seasonIndex() of its first airing, -1 when unknown.
 *
 * @typedef {object} Song
 * @property {number} id
 * @property {number} animeId
 * @property {string} title
 * @property {string} artist
 * @property {SongType} type
 * @property {number} number        OP1, ED2…
 * @property {number} guessRate     0-100, higher = more people know it.
 * @property {string} file          Media file name on the mirrors.
 * @property {string[]} altAnswers  Other accepted anime names (shared songs).
 * @property {string} artistRef        Identifies the artist/group (shared by all their songs).
 * @property {string[]} artistAliases  The credited artist/group and its alternative names.
 * @property {string[][]} artistMembers For groups: each member's names (empty for solo artists).
 *
 * @typedef {object} Cell
 * @property {number} areaIndex     Sector index, NEUTRAL_AREA (-1) or VOID_AREA (-2, not walkable).
 * @property {'start' | 'key' | 'door' | null} content
 *
 * @typedef {object} Area
 * @property {number} index
 * @property {string | null} tag    null = mixed (no tag constraint).
 *
 * @typedef {object} Door
 * @property {number} areaIndex     NEUTRAL_AREA for the neutral area's door.
 * @property {number} x
 * @property {number} y
 * @property {(string | null)[]} tags  Area themes of the floor behind this door.
 *
 * @typedef {object} Floor
 * @property {number} number
 * @property {number} size
 * @property {Cell[]} cells         Row-major, index = y * size + x.
 * @property {{x: number, y: number}} start
 * @property {Area[]} areas
 * @property {Door[]} doors         One per sector (same order as `areas`), then the neutral door.
 *
 * @typedef {object} GameSettings
 * @property {SongType[]} songTypes
 * @property {number} floors
 * @property {number} timeLimitMin
 * @property {number} rerollIntervalSec
 * @property {number} maxRerolls
 * @property {number} tilesPerArea
 * @property {number} revealAfter  Songs guessed in an area before its key and door are shown.
 * @property {'anime' | 'songArtist'} answerMode  What players must name for each song.
 * @property {'shown' | 'hidden' | 'off'} artistAreas  Anime mode: artist areas and their labels.
 * @property {boolean} anySeason   Anime mode: any entry of the franchise is a right answer.
 * @property {boolean} seasonRange Only use anime aired from fromYear/fromSeason to toYear/toSeason.
 * @property {number} fromYear
 * @property {number} fromSeason   0 Winter … 3 Fall (SEASONS).
 * @property {number} toYear
 * @property {number} toSeason
 * @property {boolean} lateJoin    Newcomers may join a running game (no AniList: the pool stays).
 */

export {};
