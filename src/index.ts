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

interface Settings {
  /**
   * Path to program to view nifs
   *
   * @default OutfitStudio
   */
  nifViewer: string;
  /**
   * Keyword to apply
   * @todo multiple keywords?
   */
  keyword: string;
  /**
   * Whether to recheck "maybe" answers
   */
  redoMaybes: boolean;
  /**
   * Body slots to consider unrelated to keyword (e.g., head things).
   */
  irrelevantSlots: readonly string[];
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
}

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

registerPatcher<Locals, Settings>({
  info: info,
  gameModes: [xelib.gmSSE, xelib.gmTES5],
  settings: {
    label: 'Mechanical Turk armor keywords',
    templateUrl: `${patcherUrl}/partials/settings.html`,
    defaultSettings: {
      nifViewer: 'CalienteTools/BodySlide/OutfitStudio x64.exe',
      // TODO: Support other keywords?
      keyword: 'SOS_Revealing',
      redoMaybes: false,
      irrelevantSlots: [
        '30 - Head',
        '31 - Hair',
        '33 - Hands',
        '34 - Forearms',
        '41 - LongHair',
        '42 - Circlet',
        '43 - Ears',
      ],
    },
  },
  getFilesToPatch(filenames) {
    // TODO: Figure out why ignoring zEBD in GUI doesn't work
    return filenames.filter((filename) => filename !== 'zEBD.esp');
  },
  execute(patchFile, helpers, settings, locals) {
    const { keyword, redoMaybes, irrelevantSlots } = settings;

    return {
      initialize() {
        locals.dir = xelib.GetGlobal('DataPath');
        // @ts-ignore
        locals.taggednifs = fh.loadJsonFile(memoryFile, {}) ?? {};

        // Create KYWD records for keywords
        const kywd = xelib.AddElement(patchFile, 'KYWD\\KYWD');
        xelib.AddElement(kywd, 'EDID - Editor ID');
        helpers.cacheRecord(kywd as RecordHandle, keyword);

        // Look up DefaultRace
        locals.DefaultRace = xelib.GetRecord(0, 0x19);
      },
      process: [
        {
          load: {
            signature: 'ARMO',
            filter(record) {
              const { DefaultRace } = locals;

              const armo = xelib.GetWinningOverride(record);

              if (xelib.HasKeyword(armo, keyword)) {
                // Ignore ARMO that already have this keyword
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

              if (xelib.GetFlag(bod, 'First Person Flags', '52 - Unnamed')) {
                // Ignore armor with SoS slot?
                return false;
              }

              // Check all slot 32 ARMOs?
              return xelib.GetFlag(bod, 'First Person Flags', '32 - Body');
            },
          },
          async patch(record) {
            const { dir, taggednifs, DefaultRace } = locals;

            /**
             * Add a new hash/answer pair to our memories.
             */
            function addAnswer(hash: string, answer: Answer): void {
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
            const answers: Answered[] = hashes.map((hash) => {
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
            // Get previous answers about nif keywords for only relevant ARMAs
            const relevantAnswers = answers.filter((_, i) => {
              const arma = armas[i];
              const bod = getBodyTemplate(arma);
              const flags = xelib.GetEnabledFlags(bod, 'First Person Flags');
              helpers.logMessage(`${xelib.EditorID(arma)}: ${flags}`);

              // Check if unanswered ARMA relevant
              return flags.some((flag) => !irrelevantSlots.includes(flag));
            });

            // Try to choose tag automagically based on relevant past answers
            if (relevantAnswers.every((answer) => answer === Answer.Yes)) {
              helpers.logMessage(
                `All relevant nifs already known to be ${keyword}`
              );
              // Apply tag to this ARMO
              return xelib.AddKeyword(armo, keyword);
            }
            // Assume no if single no?
            if (relevantAnswers.some((answer) => answer === Answer.No)) {
              helpers.logMessage(
                `One of the relevant nifs already known to not be ${keyword}`
              );
              return;
            }

            // Show nifs
            // TODO: How to close it programatically without breaking vfs?
            const viewer = Promise.fromCallback((cb) =>
              execFile(settings.nifViewer, nifs, { cwd: dir }, cb)
            );

            // TODO: Show dialog and viewer at same time?
            const choice: number = (dialog.showMessageBox({
              // @ts-ignore
              type: 'question',
              message: `Apply ${keyword}?`,
              title: editorid,
              buttons: ['Yes', 'Maybe Yes', 'Maybe No', 'No', 'Cancel'],
            }) as unknown) as number;
            helpers.logMessage(`Choice: ${choice}`);

            switch (choice) {
              case 0: // Yes
              case 1: // MaybeYes
                // Apply tag to this ARMO
                xelib.AddKeyword(armo, keyword);
                // Record all nifs as keyword
                hashes.forEach((hash) =>
                  addAnswer(hash, choice === 0 ? Answer.Yes : Answer.MaybeYes)
                );
                break;
              case 2: // MaybeNo
              case 3: // No
                // Filter out nifs that are definitely revealing
                const hhashes = hashes.filter(
                  (_, i) => answers[i] !== Answer.Yes
                );
                // If only one nif left, it must be the non-revealing one
                if (hhashes.length === 1) {
                  addAnswer(
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

            // Update memory
            fh.saveJsonFile(memoryFile, taggednifs as any);

            await viewer;
          },
        },
      ],
    };
  },
});
