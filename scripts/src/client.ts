import * as StellarSdk from "@kinecosystem/kin-sdk";
import {
	Asset,
	Keypair,
	Account,
	// CollectionPage,
	// PaymentOperationRecord
} from "@kinecosystem/kin-sdk";

import { KinNetwork } from "./networks";
import {
	Operations,
	NativeBalance,
	getKinBalance,
	KinPayment,
	isNativeBalance
} from "./stellar";

export { Keypair };

export type Address = string;

export type OnPaymentListener = (payment: Payment) => void;

export interface Payment {
	readonly id: string;
	readonly hash: string;
	readonly amount: number;
	readonly sender: string;
	readonly recipient: string;
	readonly timestamp: string;
	readonly memo: string | undefined;
}

export type Balance = {
	readonly cached: number;
	update(): Promise<number>;
};

function fromStellarPayment(sp: KinPayment): Payment {
	return {
		id: sp.id,
		hash: sp.id,
		memo: sp.memo,
		sender: sp.from,
		recipient: sp.to,
		timestamp: sp.created_at,
		amount: Number(sp.amount)
	};
}

async function getPaymentsFrom(collection: StellarSdk.Server.CollectionPage<StellarSdk.Server.PaymentOperationRecord>): Promise<Payment[]> {
	const payments = await KinPayment.allFrom(collection);
	return payments
		.filter(payment => payment) // TODO check that payments are native asset
		.map(fromStellarPayment);
}

export interface KinWallet {
	readonly address: string;
	readonly balance: Balance;

	getPayments(): Promise<Payment[]>;

	onPaymentReceived(listener: OnPaymentListener): void;

	pay(recipient: Address, amount: number, memo?: string): Promise<Payment>;
}

class PaymentStream {
	private static readonly POLLING_INTERVAL = 2000;

	private readonly accountId: string;
	private readonly network: KinNetwork;

	private timer: any | undefined;
	private cursor: string | undefined;
	private listener: OnPaymentListener | undefined;

	constructor(network: KinNetwork, accountId: string) {
		this.network = network;
		this.accountId = accountId;
		this.check = this.check.bind(this);
	}

	public setListener(listener: OnPaymentListener) {
		this.listener = listener;
	}

	public start() {
		if (this.timer === undefined) {
			this.timer = setTimeout(this.check, PaymentStream.POLLING_INTERVAL);
		}
	}

	public stop() {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private async check() {
		const builder = this.network.server
			.payments()
			.forAccount(this.accountId)
			.order("desc");

		if (this.cursor) {
			builder.cursor(this.cursor);
		}

		const payments = await builder.call();

		if (this.listener) {
			(await getPaymentsFrom(payments))
				.forEach(payment => this.listener!(payment));
		}

		this.start();
	}
}

class Wallet implements KinWallet {
	public static async create(operations: Operations, network: KinNetwork, keys: Keypair, account: Account, kinBalance: NativeBalance): Promise<KinWallet> {
		return new Wallet(operations, network, keys, account, kinBalance);
	}

	private readonly keys: Keypair;
	private readonly account: Account;
	private readonly network: KinNetwork;
	private readonly operations: Operations;
	private readonly payments: PaymentStream;

	private kinBalance: NativeBalance;

	private constructor(operations: Operations, network: KinNetwork, keys: Keypair, account: Account, kinBalance: NativeBalance) {
		this.keys = keys;
		this.account = account;
		this.network = network;
		this.kinBalance = kinBalance;
		this.operations = operations;
		this.updateBalance = this.updateBalance.bind(this);
		this.payments = new PaymentStream(this.network, this.keys.publicKey());
	}

	public onPaymentReceived(listener: OnPaymentListener) {
		this.payments.setListener(listener);
		this.payments.start();
	}

	public async pay(recipient: Address, amount: number, memo?: string): Promise<Payment> {
		const op = StellarSdk.Operation.payment({
			destination: recipient, // TODO do I need specify a native asset?
			amount: amount.toString()
		});

		if (memo && typeof memo !== "string") {
			memo = undefined;
		}

		const payment = await this.operations.send(op, memo);
		const operation = await this.operations.getPaymentOperationRecord(payment.hash);
		return fromStellarPayment(await KinPayment.from(operation));
	}

	public async getPayments() {
		const payments = await this.network.server
			.payments()
			.forAccount(this.keys.publicKey())
			.order("desc")
			.limit(10)
			.call();

		return await getPaymentsFrom(payments);
	}

	public get address() {
		return this.keys.publicKey();
	}

	public get balance() {
		const self = this;

		return {
			get cached() {
				return parseFloat(self.kinBalance!.balance);
			},
			async update() {
				await self.updateBalance();
				return parseFloat(self.kinBalance!.balance);
			}
		};
	}

	private async updateBalance() {
		const account = await this.network.server.loadAccount(this.keys.publicKey());
		this.kinBalance = getKinBalance(account);
	}
}

export async function create(network: KinNetwork, keys: Keypair) {
	const operations = Operations.for(network.server, keys);
	const accountResponse = await operations.loadAccount(keys.publicKey());

	const account = new Account(accountResponse.accountId(), accountResponse.sequenceNumber());
	const nativeBalance = accountResponse.balances.find(isNativeBalance);
	const kinBalance = getKinBalance(accountResponse);

	if (!nativeBalance) {
		throw new Error("account contains no balance");
	}

	return Wallet.create(operations, network, keys, account, kinBalance);
}
