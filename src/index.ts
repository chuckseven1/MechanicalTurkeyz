/// <reference types='@zedit/upf' />

import { execFile } from 'child_process';
import { createReadStream } from 'fs';
import { createHash } from 'crypto';
import { remote } from 'electron';

import type * as Bluebird from 'bluebird';

import type { ElementHandle, RecordHandle } from 'xelib';

export = 0;

const { dialog } = remote;

// Promise global is bluebird
declare const Promise: typeof Bluebird;

const enum Answer {
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
const enum KeywordType {
  /**
   * If any part of a thing is this keyword the whole thing is.
   *
   * @example ArmorHelmet?
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
 * Body slots
 */
const enum BodySlot {
  Head = '30 - Head',
  Hair = '31 - Hair',
  Body = '32 - Body',
  Hands = '33 - Hands',
  Forearms = '34 - Forearms',
  Amulet = '35 - Amulet',
  Ring = '36 - Ring',
  Feet = '37 - Feet',
  Calves = '38 - Calves',
  Shield = '39 - Shield',
  Tail = '40 - Tail',
  LongHair = '41 - LongHair',
  Circlet = '42 - Circlet',
  Ears = '43 - Ears',
  /**
   * face/mouth
   */
  FaceMouth = '44 - Unnamed',
  /**
   * neck (like a cape, scarf, shawl, neck-tie etc.)
   */
  Neck = '45 - Unnamed',
  /**
   * chest primary or outergarment
   */
  ChestPrimary = '46 - Unnamed',
  /**
   * back (like a backpack/wings etc.)
   */
  Back = '47 - Unnamed',
  /**
   * misc/FX
   */
  Misc48 = '48 - Unnamed',
  /**
   * pelvis primary or outergarment
   */
  PelvisPrimary = '49 - Unnamed',
  DecapitatedHead = '50 - DecapitateHead',
  Decapitate = '51 - Decapitate',
  /**
   * pelvis secondary or undergarment
   */
  PelvisSecondary = '52 - Unnamed',
  /**
   * slot used by SoS
   */
  SoS = PelvisSecondary,
  /**
   * leg primary or outergarment or right leg
   */
  LegPrimary = '53 - Unnamed',
  /**
   * leg secondary or undergarment or left leg
   */
  LegSecondary = '54 - Unnamed',
  /**
   * face alternate or jewelry
   */
  FaceAlternate = '55 - Unnamed',
  /**
   * chest secondary or undergarment
   */
  ChestSecondary = '56 - Unnamed',
  /**
   * shoulder
   */
  Shoulder = '57 - Unnamed',
  /**
   * arm secondary or undergarment or left arm
   */
  ArmSecondary = '58 - Unnamed',
  /**
   * arm primary or outergarment or right arm
   */
  ArmPrimary = '59 - Unnamed',
  /**
   * misc/FX
   */
  Misc60 = '60 - Unnamed',
  FX01 = '61 - FX01',
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
  relevantSlots: readonly BodySlot[];
  /**
   * Irrelevant slots (i.e., slots which can be ignored).
   */
  irrelevantSlots: readonly BodySlot[];
  /**
   * Slots which mean keywords should not be applied.
   * (e.g., slot 52 for SOS_Revealing)
   */
  skipSlots: readonly BodySlot[];
}

/**
 * Known keywords.
 *
 * @todo read these from a JSON file or something so adding to it is easier.
 */
const keywords: Record<string, KeywordInfo> = <const>{
  SOS_Revealing: {
    id: 'SOS_Revealing',
    description: 'SoS revealing keyword',
    type: KeywordType.Exclusive,
    relevantSlots: [BodySlot.Body],
    /**
     * @todo add more slots to this list?
     */
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

enum Model {
  Male = 'Male world model\\MOD2',
  Female = 'Female world model\\MOD3',
}

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
  keywords: readonly string[];
  /**
   * Whether to recheck "maybe" answers
   */
  redoMaybes: boolean;
  /**
   * Which model to display when asking user about keywords.
   *
   * @todo add both setting?
   */
  displayModel: keyof typeof Model;
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
  keywords: readonly KeywordInfo[];
  /**
   * Handles to our created KYWD records.
   */
  kywds: RecordHandle[];
  /**
   * List of keywords that need patching.
   */
  keywordsToPatch: { [recordid: string]: string[] };
}

/**
 * Load memories from a file.
 *
 * @see Memories
 * @todo validate format
 */
function loadMemories(filename: string = memoryFile): Memories {
  // loadJsonFile seems to return undefined despite my default of {}?
  const contents: unknown = fh.loadJsonFile(filename, {}) ?? {};

  return contents as Memories;
}
/**
 * Save memories to a file.
 *
 * @see Memories
 */
function saveMemories(memories: Memories, filename: string = memoryFile): void {
  fh.saveJsonFile(filename, memories as any);
}

/**
 * Ask user for external memories file,
 * then merge it into our memories.
 *
 * @see Memories
 * @see memoryFile
 */
function importMemories() {
  // Ask user for a file
  const filename = fh.selectFile(`${info.name} Memory Files`, '', [
    { name: 'JSON files', extensions: ['json'] },
  ]);
  if (!filename) {
    return;
  }

  // Load memories
  const memories = loadMemories();
  const newMemories = loadMemories(filename);

  // Merge memories, preferring old ones if conflict
  for (const hash in newMemories) {
    const { filenames, keywords } = newMemories[hash]!;
    const memory = memories[hash];

    if (!memory) {
      // Hash is new to us
      memories[hash] = { filenames, keywords };
      continue;
    }

    // Merge our memory of this hash with new one
    memories[hash] = {
      // Union of filenames
      filenames: [...new Set([...memory.filenames, ...filenames])],
      // Merge keyword answers, preferring ours on conflict
      keywords: Object.assign(keywords, memory.keywords),
    };
  }

  // Save new combined memories
  saveMemories(memories);
}

registerPatcher<Locals, Settings>({
  info: info,
  gameModes: [xelib.gmSSE, xelib.gmTES5],
  settings: {
    label: 'Mechanical Turk armor keywords',
    templateUrl: `${patcherUrl}/partials/settings.html`,
    controller($scope: any) {
      // Add callbacks
      $scope.importMemories = importMemories;
      // Add variables needed for rending settings?
      $scope.knownKeywords = Object.keys(keywords);
      $scope.models = Object.keys(Model);
    },
    defaultSettings: <const>{
      nifViewer: 'CalienteTools/BodySlide/OutfitStudio x64.exe',
      keywords: ['SOS_Revealing'],
      redoMaybes: false,
      displayModel: 'Female',
    },
  },
  getFilesToPatch(filenames) {
    return filenames.filter((filename) => filename !== 'zEBD.esp');
  },
  execute(patchFile, helpers, settings, locals) {
    const { redoMaybes, displayModel } = settings;

    return {
      initialize() {
        /**
         * Help make sure I initialize everything.
         */
        function doInitialize() {
          return {
            dir: xelib.GetGlobal('DataPath'),
            taggednifs: loadMemories(),
            // Look up DefaultRace
            DefaultRace: xelib.GetRecord(0, 0x19),
            keywords: settings.keywords.map((keyword) => keywords[keyword]),
            kywds: settings.keywords.map((keyword) => {
              // Create KYWD records for keywords
              const kywd = xelib.AddElement(patchFile, 'KYWD\\KYWD');
              xelib.AddElement(kywd, 'EDID - Editor ID');
              return helpers.cacheRecord(kywd as RecordHandle, keyword);
            }),
            keywordsToPatch: {},
          };
        }

        locals = doInitialize();
      },
      /**
       * Clean up any of our KYWD records we didn't use.
       */
      finalize() {
        xelib.BuildReferences(patchFile, true);
        for (const kywd of locals.kywds) {
          const refs = xelib.GetReferencedBy(kywd);
          if (refs.length === 0) {
            xelib.RemoveElement(patchFile, xelib.GetHexFormID(kywd));
          }
        }
      },
      process: [
        {
          load: {
            signature: 'ARMO',
            filter(record) {
              const { keywords, keywordsToPatch, DefaultRace } = locals;

              const armo = xelib.GetWinningOverride(record);
              const editorid = xelib.EditorID(armo);

              // Track the keywords to maybe apply to this record
              keywordsToPatch[editorid] = settings.keywords.concat();
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
                xelib.GetValue(arma, Model[displayModel])
              )
              .filter((nif) => !!nif)
              .map((nif) => `meshes\\${nif}`);
            if (nifs.length === 0) {
              // Nothing to do?
              return;
            }

            let hashes: readonly string[];
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
            const answers: { [keyword: string]: readonly Answered[] } = {};
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
            const relevantAnswers: {
              [keyword: string]: readonly Answered[];
            } = {};
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

              // Try to choose tag automagically based on relevant past answers
              // TODO: Clean up this logic?
              switch (type) {
                case KeywordType.Inclusive:
                  // Assume yes if single yes?
                  if (
                    relevantAnswers[keyword].some(
                      (answer) => answer === Answer.Yes
                    )
                  ) {
                    helpers.logMessage(
                      `One of the relevant nifs already known to be ${keyword}`
                    );
                    // Apply tag to this ARMO
                    return xelib.AddKeyword(armo, keyword);
                  }
                  // Assume no if all no?
                  if (
                    relevantAnswers[keyword].every(
                      (answer) => answer === Answer.No
                    )
                  ) {
                    helpers.logMessage(
                      `One of the relevant nifs already known to not be ${keyword}`
                    );
                    return;
                  }
                  break;
                case KeywordType.Exclusive:
                  // Assume yes if all yes
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
            // TODO: Make single dialog for multipe keywords?
            enum Choice {
              'Yes' = 0,
              'Maybe Yes',
              'Maybe No',
              'No',
              'Cancel',
            }
            const buttons = Object.keys(Choice).filter((k) => isNaN(+k));
            const choices = await Promise.map(
              keywordsToAsk,
              (keyword) =>
                (dialog.showMessageBox({
                  // @ts-ignore
                  type: 'question',
                  message: `Apply ${keyword}?`,
                  title: editorid,
                  buttons,
                }) as unknown) as Choice
            );

            // Do "learning" from user answers
            choices.forEach((choice, i) => {
              const keyword = keywordsToAsk[i];
              const { type } = keywords[keyword];

              // TODO: Clean up this logic?
              switch (type) {
                case KeywordType.Inclusive:
                  switch (choice) {
                    case Choice['Yes']:
                    case Choice['Maybe Yes']:
                      // Filter out relevant nifs that are definitely not tag
                      const hhashes = relevantHashes[keyword].filter(
                        (_, i) => relevantAnswers[keyword][i] !== Answer.No
                      );
                      // If only one nif left, it must be the keyword one
                      if (hhashes.length === 1) {
                        addAnswer(
                          keyword,
                          hhashes[0],
                          choice === Choice['Yes']
                            ? Answer.Yes
                            : Answer.MaybeYes
                        );
                      } else {
                        // TODO: How to handle Yes answer with multiple nifs invloved?
                      }
                      break;
                    case Choice['No']:
                    case Choice['Maybe No']:
                      // Record all nifs as not keyword
                      hashes.forEach((hash) =>
                        addAnswer(
                          keyword,
                          hash,
                          choice === Choice['No'] ? Answer.No : Answer.MaybeNo
                        )
                      );
                      break;
                    case Choice['Cancel']:
                      throw new Error('Cancelled by user');
                  }
                  break;
                case KeywordType.Exclusive:
                  switch (choice) {
                    case Choice['Yes']:
                    case Choice['Maybe Yes']:
                      // Apply tag to this ARMO
                      xelib.AddKeyword(armo, keyword);
                      // Record all nifs as keyword
                      hashes.forEach((hash) =>
                        addAnswer(
                          keyword,
                          hash,
                          choice === Choice['Yes']
                            ? Answer.Yes
                            : Answer.MaybeYes
                        )
                      );
                      break;
                    case Choice['No']:
                    case Choice['Maybe No']:
                      // Filter out relevant nifs that are definitely revealing
                      const hhashes = relevantHashes[keyword].filter(
                        (_, i) => relevantAnswers[keyword][i] !== Answer.Yes
                      );
                      // If only one nif left, it must be the non-revealing one
                      if (hhashes.length === 1) {
                        addAnswer(
                          keyword,
                          hhashes[0],
                          choice === Choice['No'] ? Answer.No : Answer.MaybeNo
                        );
                      } else {
                        // TODO: How to handle No answer with multiple nifs invloved?
                      }
                      break;
                    case Choice['Cancel']:
                      throw new Error('Cancelled by user');
                  }
                  break;
                default:
                  return invalidKeywordType(type);
              }
            });

            // Update memory
            saveMemories(taggednifs);

            // Wait for viewer to close
            await viewer;
          },
        },
      ],
    };
  },
});
