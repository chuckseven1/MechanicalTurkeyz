/// <reference types='@zedit/upf' />

import { execFile } from 'child_process';
import { createReadStream } from 'fs';
import { createHash } from 'crypto';
import { remote } from 'electron';

import type * as Bluebird from 'bluebird';

import { ElementHandle, RecordHandle } from 'xelib';

export = 0;

const { dialog } = remote;

// Promise global is bluebird
declare const Promise: typeof Bluebird;

enum Answer {
  /**
   * Tag definitely applies (do not ask again)
   */
  Yes = 1,
  /**
   * Tag definitely does not apply (do not ask again)
   */
  No,
  /**
   * Tag maybe applies (ask again if `redoMaybes`, o.w. treat as Yes)
   */
  MaybeYes,
  /**
   * Tag maybe does not apply (ask again if `redoMaybes`, o.w. treat as No)
   */
  MaybeNo,
}

type Answered = Answer.Yes | Answer.No | undefined;

/**
 * How to track what we have "learned".
 */
interface Memory {
  /**
   * The names we have seen this as.
   */
  filenames: string[];
  /**
   * Knowledge about which keywords apply.
   */
  keywords: { [keyword: string]: Answer | undefined };
}

/**
 * Remember things by hash rather than file.
 */
interface Memories {
  [filehash: string]: Memory | undefined;
}

/**
 * JSON file for storing what we have "learned".
 */
const memoryFile = 'MechanicalTurkeyz.json';

/**
 * Fetcher either BODT or BOD2 from a record
 * @todo Does xelib have a function for this?
 */
function getBodyTemplate(record: RecordHandle): ElementHandle | 0 {
  const bodt = xelib.GetElement(record, 'BODT');

  return bodt === 0 ? xelib.GetElement(record, 'BOD2') : bodt;
}

/**
 * Types of keywords
 *
 * @todo better names?
 */
enum KeywordType {
  /**
   * If part of a thing is this keyword the whole thing is.
   *
   * @example ArmorHelmet
   */
  Inclusive,
  /**
   * Only applies if everything meets keyword criteria.
   *
   * @example SOS_Revealing
   */
  Exclusive,
}

function invalidKeywordType(type: never): never {
  throw new Error(`Invalid keyword type: ${type}`);
}

/**
 * @todo add other body slots
 */
enum BodySlot {
  Head = '30 - Head',
  Hair = '31 - Hair',
  Body = '32 - Body',
  Hands = '33 - Hands',
  Forearms = '34 - Forearms',
  LongHair = '41 - LongHair',
  Circlet = '42 - Circlet',
  Ears = '43 - Ears',
  SoS = '52 - Unnamed',
}

/**
 * Description of a keyword for the "learing" alrogirithm.
 */
interface KeywordInfo {
  /**
   * The EditorID of the keword.
   */
  id: string;
  /**
   * Description to show users.
   */
  description: string;
  /**
   * What type of keyword this is?
   */
  type: KeywordType;
  /**
   * Relevant slots (i.e., slots to which this keyword might apply).
   */
  relevantSlots: BodySlot[];
  /**
   * Irrelevant slots (i.e., slots which can be ignored).
   */
  irrelevantSlots: BodySlot[];
  /**
   * Slots which mean keywords should not be applied.
   * (e.g., slot 52 for SOS_Revealing)
   */
  skipSlots: BodySlot[];
}

/**
 * Known keywords.
 * @todo read these from a JSON file or something so adding to it is easier.
 */
const keywords: Record<string, KeywordInfo> = {
  SOS_Revealing: {
    id: 'SOS_Revealing',
    description: 'SoS revealing keyword',
    type: KeywordType.Exclusive,
    relevantSlots: [BodySlot.Body],
    irrelevantSlots: [
      BodySlot.Head,
      BodySlot.Hair,
      BodySlot.Hands,
      BodySlot.Forearms,
      BodySlot.LongHair,
      BodySlot.Circlet,
      BodySlot.Ears,
    ],
    skipSlots: [BodySlot.SoS],
  },
};

interface Settings {
  /**
   * Path to program to view nifs
   *
   * @default OutfitStudio
   */
  nifViewer: string;
  /**
   * Keywords to apply
   */
  keywords: string[];
  /**
   * Whether to recheck "maybe" answers
   */
  redoMaybes: boolean;
}

interface Locals {
  /**
   * Data directory
   */
  dir: string;
  /**
   * Track nifs that match tag
   */
  taggednifs: Memories;
  /**
   * Handle to DefaultRace record
   *
   * Used for filtering out ARMAs for creature races.
   */
  DefaultRace: RecordHandle;
  /**
   * Descriptions of keywords being patched.
   *
   * @see KeywordInfo
   */
  keywords: KeywordInfo[];
  /**
   * List of keywords that need patching.
   */
  keywordsToPatch: { [recordid: string]: string[] };
}

registerPatcher<Locals, Settings>({
  info: info,
  gameModes: [xelib.gmSSE, xelib.gmTES5],
  settings: {
    label: 'Mechanical Turk armor keywords',
    templateUrl: `${patcherUrl}/partials/settings.html`,
    defaultSettings: {
      nifViewer: 'CalienteTools/BodySlide/OutfitStudio x64.exe',
      keywords: ['SOS_Revealing'],
      redoMaybes: false,
    },
  },
  getFilesToPatch(filenames) {
    // TODO: Figure out why ignoring zEBD in GUI doesn't work
    return filenames.filter((filename) => filename !== 'zEBD.esp');
  },
  execute(patchFile, helpers, settings, locals) {
    const { redoMaybes } = settings;

    return {
      initialize() {
        /**
         * Help make sure I initialize everything.
         */
        function doInitialize() {
          return {
            dir: xelib.GetGlobal('DataPath'),
            taggednifs: ((fh.loadJsonFile(memoryFile, {}) ??
              {}) as unknown) as Memories,
            // Look up DefaultRace
            DefaultRace: xelib.GetRecord(0, 0x19),
            keywords: settings.keywords.map((keyword) => {
              // Create KYWD records for keywords
              const kywd = xelib.AddElement(patchFile, 'KYWD\\KYWD');
              xelib.AddElement(kywd, 'EDID - Editor ID');
              helpers.cacheRecord(kywd as RecordHandle, keyword);

              return keywords[keyword];
            }),
            keywordsToPatch: {},
          };
        }

        locals = doInitialize();
      },
      process: [
        {
          load: {
            signature: 'ARMO',
            filter(record) {
              const { keywords, keywordsToPatch, DefaultRace } = locals;

              const armo = xelib.GetWinningOverride(record);
              const editorid = xelib.EditorID(armo);

              keywordsToPatch[editorid] = settings.keywords;
              function removeKeyword(keyword: string) {
                keywordsToPatch[editorid] = keywordsToPatch[editorid].filter(
                  (k) => k !== keyword
                );
              }

              keywords.forEach(({ id }) => {
                // Ignore ARMO that already has this keyword
                if (xelib.HasKeyword(armo, id)) {
                  // TODO: Add setting to check these too?
                  removeKeyword(id);
                }
              });
              // Ignore ARMO that already has all the keywords
              if (keywordsToPatch[editorid].length === 0) {
                return false;
              }

              if (!xelib.HasElement(armo, 'Armature')) {
                // Ignore AMRO with no ARMAs?
                return false;
              }
              // Try to find "people" ARMAs?
              // @ts-ignore
              const armas = xelib.GetElements(armo, 'Armature');
              if (
                !armas.some((el) => {
                  const arma = xelib.GetWinningOverride(
                    xelib.GetLinksTo(el, '')
                  );
                  const rnam = xelib.GetLinksTo(arma, 'RNAM');
                  return rnam && xelib.ElementEquals(rnam, DefaultRace);
                })
              ) {
                // Ignore if no DefaultRace ARMAs?
                return false;
              }

              /*
              if (
                !xelib.ElementEquals(
                  xelib.GetLinksTo(armo, 'RNAM'),
                  DefaultRace
                )
              ) {
                // Ignore ARMO with non-default RNAM?
                // Seems to be best way to find "people" armors
                return false;
              }
               */

              const bod = getBodyTemplate(armo);
              if (bod === 0) {
                // Ignore if no Body Template?
                return false;
              }

              const flags = xelib.GetEnabledFlags(
                bod,
                'First Person Flags'
              ) as BodySlot[];

              keywords.forEach(({ id, skipSlots }) => {
                // Ignore amror with any of the skip slots
                if (flags.some((flag) => skipSlots.includes(flag))) {
                  removeKeyword(id);
                }
              });
              // Ingore armor if skipping every keyword
              if (keywordsToPatch[editorid].length === 0) {
                return false;
              }

              keywords.forEach(({ id, relevantSlots }) => {
                // Ignore armor with none of the relevant slots
                if (!flags.some((flag) => relevantSlots.includes(flag))) {
                  removeKeyword(id);
                }
              });
              // Ingore armor if skipping every keyword
              if (keywordsToPatch[editorid].length === 0) {
                return false;
              }

              // Found no reason to skip this record
              return true;
            },
          },
          async patch(record) {
            const { dir, taggednifs, DefaultRace } = locals;

            /**
             * Add a new hash/answer pair to our memories.
             */
            function addAnswer(
              keyword: string,
              hash: string,
              answer: Answer
            ): void {
              const { filenames = [], keywords = {} } = taggednifs[hash] ?? {};

              keywords[keyword] = answer;

              taggednifs[hash] = { filenames, keywords };
            }
            /**
             * Add a new hash/name pair to our memories.
             */
            function addName(hash: string, nif: string): void {
              const { filenames = [], keywords = {} } = taggednifs[hash] ?? {};

              if (filenames.indexOf(nif) < 0) {
                filenames.push(nif);
              }

              taggednifs[hash] = { filenames, keywords };
            }

            const armo = xelib.GetWinningOverride(record);

            const editorid = xelib.EditorID(armo);
            helpers.logMessage(`Checking ${editorid}`);

            // TODO: Do this better?
            const keywordsToPatch = locals.keywordsToPatch[editorid];
            delete locals.keywordsToPatch[editorid];

            // Get all the ARMAs for this ARMO
            const armas = xelib
              // @ts-ignore
              .GetElements(armo, 'Armature')
              .map((el) => xelib.GetWinningOverride(xelib.GetLinksTo(el, '')))
              // Try to ignore creature ARMAs?
              .filter((arma) =>
                xelib.ElementEquals(xelib.GetLinksTo(arma, 'RNAM'), DefaultRace)
              );

            // Get the nifs
            const nifs = armas
              .map((arma) =>
                // TODO: handle alternate textures?
                // TODO: handle male/female models?
                xelib.GetValue(arma, 'Female world model\\MOD3')
              )
              .filter((nif) => !!nif)
              .map((nif) => `meshes\\${nif}`);
            if (nifs.length === 0) {
              // Nothing to do?
              return;
            }

            let hashes: string[];
            try {
              // Hash the nifs
              hashes = await Promise.map(nifs, (nif) => {
                const hash = createHash('sha1');
                hash.setEncoding('hex');
                const fd = createReadStream(dir + nif);
                return new Promise<string>((resolve, reject) => {
                  fd.on('end', () => {
                    hash.end();
                    resolve(hash.read());
                  });
                  fd.on('error', (err) => reject(err));
                  fd.pipe(hash);
                });
              }).each((hash, i) => addName(hash, nifs[i]));
            } catch (err) {
              // TODO: Support reading nifs from inside BSAs?
              helpers.logMessage(`Error opening nif: ${err}`);
              // Skip this AMRO?
              return;
            }

            helpers.logMessage(`Found nifs for ${editorid}: ${nifs}`);

            // Get previous answers about nif keywords
            const answers: { [keyword: string]: Answered[] } = {};
            keywordsToPatch.forEach((keyword) => {
              answers[keyword] = hashes.map((hash) => {
                const answer = taggednifs[hash]?.keywords[keyword];

                // Handle "maybe" memories
                switch (answer) {
                  case Answer.MaybeYes:
                    return redoMaybes ? undefined : Answer.Yes;
                  case Answer.MaybeNo:
                    return redoMaybes ? undefined : Answer.No;
                  default:
                    return answer;
                }
              });
            });
            // Get previous answers about nif keywords for only relevant ARMAs
            const relevantAnswers: { [keyword: string]: Answered[] } = {};
            const relevantHashes: { [keyword: string]: string[] } = {};
            keywordsToPatch.forEach((keyword) => {
              const { irrelevantSlots } = keywords[keyword];

              relevantHashes[keyword] = [];
              relevantAnswers[keyword] = answers[keyword].filter((_, i) => {
                const arma = armas[i];
                const bod = getBodyTemplate(arma);
                const flags = xelib.GetEnabledFlags(
                  bod,
                  'First Person Flags'
                ) as BodySlot[];
                helpers.logMessage(`${xelib.EditorID(arma)}: ${flags}`);

                // Check if unanswered ARMA relevant
                if (flags.some((flag) => !irrelevantSlots.includes(flag))) {
                  relevantHashes[keyword].push(hashes[i]);
                  return true;
                }
                return false;
              });
            });

            const keywordsToAsk: string[] = [];
            keywordsToPatch.forEach((keyword) => {
              const { type } = keywords[keyword];
              switch (type) {
                case KeywordType.Inclusive:
                  // TODO: Implement this type
                  throw new Error('Not yet implemented');
                case KeywordType.Exclusive:
                  // Try to choose tag automagically based on relevant past answers
                  if (
                    relevantAnswers[keyword].every(
                      (answer) => answer === Answer.Yes
                    )
                  ) {
                    helpers.logMessage(
                      `All relevant nifs already known to be ${keyword}`
                    );
                    // Apply tag to this ARMO
                    return xelib.AddKeyword(armo, keyword);
                  }
                  // Assume no if single no?
                  if (
                    relevantAnswers[keyword].some(
                      (answer) => answer === Answer.No
                    )
                  ) {
                    helpers.logMessage(
                      `One of the relevant nifs already known to not be ${keyword}`
                    );
                    return;
                  }
                  break;
                default:
                  return invalidKeywordType(type);
              }

              // Ask the user for input
              keywordsToAsk.push(keyword);
            });

            if (keywordsToAsk.length === 0) {
              // Nothing to ask user about
              return;
            }

            // Show nifs
            // TODO: How to close it programatically without breaking vfs?
            const viewer = Promise.fromCallback((cb) =>
              execFile(settings.nifViewer, nifs, { cwd: dir }, cb)
            );

            // Ask user about remaining keywords
            const choices = await Promise.map(
              keywordsToAsk,
              (keyword) =>
                // TODO: Show dialog and viewer at same time?
                (dialog.showMessageBox({
                  // @ts-ignore
                  type: 'question',
                  message: `Apply ${keyword}?`,
                  title: editorid,
                  buttons: ['Yes', 'Maybe Yes', 'Maybe No', 'No', 'Cancel'],
                }) as unknown) as number
            );

            // Do "learning" from user answers
            choices.forEach((choice, i) => {
              const keyword = keywordsToAsk[i];

              if (keywords[keyword].type !== KeywordType.Exclusive) {
                // TODO: Implement other keyword types
                throw new Error('Not yet implemented');
              }

              switch (choice) {
                case 0: // Yes
                case 1: // MaybeYes
                  // Apply tag to this ARMO
                  xelib.AddKeyword(armo, keyword);
                  // Record all nifs as keyword
                  hashes.forEach((hash) =>
                    addAnswer(
                      keyword,
                      hash,
                      choice === 0 ? Answer.Yes : Answer.MaybeYes
                    )
                  );
                  break;
                case 2: // MaybeNo
                case 3: // No
                  // Filter out relevant nifs that are definitely revealing
                  const hhashes = relevantHashes[keyword].filter(
                    (_, i) => relevantAnswers[keyword][i] !== Answer.Yes
                  );
                  // If only one nif left, it must be the non-revealing one
                  if (hhashes.length === 1) {
                    addAnswer(
                      keyword,
                      hhashes[0],
                      choice === 3 ? Answer.No : Answer.MaybeNo
                    );
                  } else {
                    // TODO: How to handle No answer with multiple nifs invloved?
                  }
                  break;
                case 4:
                  throw new Error('Cancelled by user');
              }
            });

            // Update memory
            fh.saveJsonFile(memoryFile, taggednifs as any);

            // Wait for viewer to close
            await viewer;
          },
        },
      ],
    };
  },
});
