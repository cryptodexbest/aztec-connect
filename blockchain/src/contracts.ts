import { TransactionResponse } from '@ethersproject/abstract-provider';
import { Web3Provider } from '@ethersproject/providers';
import { EthAddress } from 'barretenberg/address';
import { Contract, ethers } from 'ethers';
import { abi as RollupABI } from './artifacts/RollupProcessor.json';
import { abi as ERC20ABI } from './artifacts/ERC20Mintable.json';
import { abi as ERC20PermitABI } from './artifacts/ERC20Permit.json';
import { RollupProofData } from 'barretenberg/rollup_proof';
import { Block } from './blockchain';
import { EthereumProvider } from './ethereum_provider';

export type EthereumSignature = { v: Buffer; r: Buffer; s: Buffer };
export type PermitArgs = { deadline: bigint; approvalAmount: bigint; signature: EthereumSignature };

export class Contracts {
  private rollupProcessor: Contract;
  private erc20Contracts: Contract[] = [];
  private provider!: Web3Provider;

  constructor(private rollupContractAddress: EthAddress, provider: EthereumProvider) {
    this.provider = new Web3Provider(provider);
    this.rollupProcessor = new ethers.Contract(rollupContractAddress.toString(), RollupABI, this.provider);
  }

  public async init() {
    const assetAddresses = await this.rollupProcessor.getSupportedAssets();
    this.erc20Contracts = await Promise.all(
      assetAddresses.map(async (a: any, index: number) => {
        const assetPermitSupport = await this.rollupProcessor.getAssetPermitSupport(index);
        const newContractABI = assetPermitSupport ? ERC20PermitABI : ERC20ABI;
        return new ethers.Contract(a, newContractABI, this.provider);
      }),
    );
  }

  public async getSupportedAssets(): Promise<EthAddress[]> {
    const assetAddresses = await this.rollupProcessor.getSupportedAssets();
    return assetAddresses.map((a: string) => EthAddress.fromString(a));
  }

  public async setSupportedAsset(assetAddress: EthAddress, supportsPermit: boolean, signingAddress?: EthAddress) {
    const signer = signingAddress ? this.provider.getSigner(signingAddress.toString()) : this.provider.getSigner(0);
    const rollupProcessor = new Contract(this.rollupContractAddress.toString(), RollupABI, signer);
    const tx = await rollupProcessor.setSupportedAsset(assetAddress.toString(), supportsPermit);
    const newContractABI = supportsPermit ? ERC20PermitABI : ERC20ABI;
    this.erc20Contracts.push(new ethers.Contract(assetAddress.toString(), newContractABI, this.provider));
    return Buffer.from(tx.hash.slice(2), 'hex');
  }

  public async getRollupStatus() {
    const nextRollupId = +(await this.rollupProcessor.nextRollupId());
    const dataSize = +(await this.rollupProcessor.dataSize());
    const dataRoot = Buffer.from((await this.rollupProcessor.dataRoot()).slice(2), 'hex');
    const nullRoot = Buffer.from((await this.rollupProcessor.nullRoot()).slice(2), 'hex');
    const rootRoot = Buffer.from((await this.rollupProcessor.rootRoot()).slice(2), 'hex');

    return {
      nextRollupId,
      dataRoot,
      nullRoot,
      rootRoot,
      dataSize,
    };
  }

  public async getEscapeHatchStatus() {
    const [escapeOpen, blocksRemaining] = await this.rollupProcessor.getEscapeHatchStatus();
    const numEscapeBlocksRemaining = blocksRemaining.toNumber();
    return {
      escapeOpen,
      numEscapeBlocksRemaining,
    };
  }

  public getRollupContractAddress() {
    return this.rollupContractAddress;
  }

  public getTokenContractAddresses() {
    return this.erc20Contracts.map(c => EthAddress.fromString(c.address));
  }

  /**
   * Send a proof to the rollup processor, which processes the proof and passes it to the verifier to
   * be verified.
   *
   * Appends viewingKeys to the proofData, so that they can later be fetched from the tx calldata
   * and added to the emitted rollupBlock.
   */
  public async sendRollupProof(
    proofData: Buffer,
    signatures: Buffer[],
    sigIndexes: number[],
    viewingKeys: Buffer[],
    signingAddress?: EthAddress,
    gasLimit?: number,
  ) {
    const signer = signingAddress ? this.provider.getSigner(signingAddress.toString()) : this.provider.getSigner(0);
    const rollupProcessor = new Contract(this.rollupContractAddress.toString(), RollupABI, signer);
    const formattedSignatures = this.solidityFormatSignatures(signatures);
    const tx = await rollupProcessor.processRollup(
      `0x${proofData.toString('hex')}`,
      formattedSignatures,
      sigIndexes,
      Buffer.concat(viewingKeys),
      { gasLimit },
    );
    return Buffer.from(tx.hash.slice(2), 'hex');
  }

  public async depositPendingFunds(
    assetId: number,
    amount: bigint,
    depositorAddress: EthAddress,
    permitArgs?: PermitArgs,
  ) {
    const signer = this.provider.getSigner(depositorAddress.toString());
    const rollupProcessor = new Contract(this.rollupContractAddress.toString(), RollupABI, signer);
    const tx = permitArgs
      ? await rollupProcessor.depositPendingFundsPermit(
          assetId,
          amount,
          depositorAddress.toString(),
          this.rollupProcessor.address,
          permitArgs.approvalAmount,
          permitArgs.deadline,
          permitArgs.signature.v,
          permitArgs.signature.r,
          permitArgs.signature.s,
          // { value: assetId === 0 ? amount : undefined },
        )
      : await rollupProcessor.depositPendingFunds(assetId, amount, depositorAddress.toString(), {
          // value: assetId === 0 ? amount : undefined,
        });
    return Buffer.from(tx.hash.slice(2), 'hex');
  }

  public async getRollupBlocksFrom(rollupId: number, minConfirmations: number) {
    const rollupFilter = this.rollupProcessor.filters.RollupProcessed(rollupId);
    const [rollupEvent] = await this.rollupProcessor.queryFilter(rollupFilter);
    if (!rollupEvent) {
      return [];
    }
    const filter = this.rollupProcessor.filters.RollupProcessed();
    const rollupEvents = await this.rollupProcessor.queryFilter(filter, rollupEvent.blockNumber);
    const txs = (await Promise.all(rollupEvents.map(event => event.getTransaction()))).filter(
      tx => tx.confirmations >= minConfirmations,
    );
    const blocks = await Promise.all(txs.map(tx => this.provider.getBlock(tx.blockNumber!)));
    return txs.map((tx, i) => this.decodeBlock({ ...tx, timestamp: blocks[i].timestamp }));
  }

  public async getUserPendingDeposit(assetId: number, account: EthAddress) {
    return BigInt(await this.rollupProcessor.getUserPendingDeposit(assetId, account.toString()));
  }

  /**
   * Format all signatures into useful solidity format. EVM word size is 32bytes
   * and we're supplying a concatenated array of signatures - so need each ECDSA
   * param (v, r, s) to occupy 32 bytes.
   *
   * Zero left padding v by 31 bytes.
   */
  private solidityFormatSignatures(signatures: Buffer[]) {
    const paddedSignatures = signatures.map(currentSignature => {
      const v = currentSignature.slice(-1);
      return Buffer.concat([currentSignature.slice(0, 64), Buffer.alloc(31), v]);
    });
    return Buffer.concat(paddedSignatures);
  }

  public async getAssetBalance(assetId: number, address: EthAddress): Promise<bigint> {
    return BigInt(await this.erc20Contracts[assetId].balanceOf(address.toString()));
  }

  public async getAssetPermitSupport(assetId: number): Promise<boolean> {
    return this.rollupProcessor.getAssetPermitSupport(assetId);
  }

  public async getUserNonce(assetId: number, address: EthAddress): Promise<bigint> {
    const tokenPermitContract = this.erc20Contracts[assetId];
    return BigInt(await tokenPermitContract.nonces(address.toString()));
  }

  public async getAssetAllowance(assetId: number, address: EthAddress): Promise<bigint> {
    return BigInt(
      await this.erc20Contracts[assetId].allowance(address.toString(), this.rollupContractAddress.toString()),
    );
  }

  private decodeBlock(tx: TransactionResponse): Block {
    const rollupAbi = new ethers.utils.Interface(RollupABI);
    const result = rollupAbi.parseTransaction({ data: tx.data });
    const rollupProofData = Buffer.from(result.args.proofData.slice(2), 'hex');
    const viewingKeysData = Buffer.from(result.args.viewingKeys.slice(2), 'hex');

    return {
      created: new Date(tx.timestamp! * 1000),
      txHash: Buffer.from(tx.hash.slice(2), 'hex'),
      rollupProofData,
      viewingKeysData,
      rollupId: RollupProofData.getRollupIdFromBuffer(rollupProofData),
      rollupSize: RollupProofData.getRollupSizeFromBuffer(rollupProofData),
    };
  }

  public async getTransactionReceipt(txHash: Buffer) {
    const txHashStr = `0x${txHash.toString('hex')}`;
    return this.provider.getTransactionReceipt(txHashStr);
  }

  public async getNetwork() {
    return this.provider.getNetwork();
  }

  public async getBlockNumber() {
    return this.provider.getBlockNumber();
  }
}