// Desktop vault: the shared vault core on top of the local disk.
import { Vault as CoreVault } from "../shared/vault";
import { NodeStorage } from "./node-storage";

export { insertUnderHeading, splitFrontmatter, VaultError } from "../shared/vault";

export class Vault extends CoreVault {
  declare readonly storage: NodeStorage;

  constructor(root: string) {
    super(new NodeStorage(root));
  }

  /** Absolute path of a vault file (for "show in folder" and the file protocol). */
  abs(rel: string): string {
    return this.storage.abs(rel);
  }
}
