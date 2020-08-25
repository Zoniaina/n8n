import { ITriggerFunctions } from 'n8n-core';
import {
	IBinaryData,
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	ITriggerResponse,
	IBinaryKeyData,
} from 'n8n-workflow';

import { connect as imapConnect, ImapSimple, ImapSimpleOptions, getParts, Message }  from 'imap-simple';
import {
	simpleParser,
	Source as ParserSource,
} from 'mailparser';

import * as lodash from 'lodash';

export class EmailReadImap implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'EmailReadImap',
		name: 'emailReadImap',
		icon: 'fa:inbox',
		group: ['trigger'],
		version: 1,
		description: 'Triggers the workflow when a new email gets received',
		defaults: {
			name: 'IMAP Email',
			color: '#44AA22',
		},
		inputs: [],
		outputs: ['main'],
		credentials: [
			{
				name: 'imap',
				required: true,
			}
		],
		properties: [
			{
				displayName: 'Mailbox Name',
				name: 'mailbox',
				type: 'string',
				default: 'INBOX',
			},
			{
				displayName: 'Action',
				name: 'postProcessAction',
				type: 'options',
				options: [
					{
						name: 'Mark as read',
						value: 'read'
					},
					{
						name: 'Nothing',
						value: 'nothing'
					},
				],
				default: 'read',
				description: 'What to do after the email has been received. If "nothing" gets<br />selected it will be processed multiple times.',
			},
			{
				displayName: 'Download Attachments',
				name: 'downloadAttachments',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						format: [
							'simple'
						],
					},
				},
				description: 'If attachments of emails should be downloaded.<br />Only set if needed as it increases processing.',
			},
			{
				displayName: 'Format',
				name: 'format',
				type: 'options',
				options: [
					{
						name: 'RAW',
						value: 'raw',
						description: 'Returns the full email message data with body content in the raw field as a base64url encoded string; the payload field is not used.'
					},
					{
						name: 'Resolved',
						value: 'resolved',
						description: 'Returns the full email with all data resolved and attachments saved as binary data.',
					},
					{
						name: 'Simple',
						value: 'simple',
						description: 'Returns the full email; do not use if you wish to gather inline attachments.',
					},
				],
				default: 'simple',
				description: 'The format to return the message in',
			},
			{
				displayName: 'Property Prefix Name',
				name: 'dataPropertyAttachmentsPrefixName',
				type: 'string',
				default: 'attachment_',
				displayOptions: {
					show: {
						format: [
							'resolved'
						],
					},
				},
				description: 'Prefix for name of the binary property to which to<br />write the attachments. An index starting with 0 will be added.<br />So if name is "attachment_" the first attachment is saved to "attachment_0"',
			},
			{
				displayName: 'Property Prefix Name',
				name: 'dataPropertyAttachmentsPrefixName',
				type: 'string',
				default: 'attachment_',
				displayOptions: {
					show: {
						format: [
							'simple'
						],
						downloadAttachments: [
							true
						],
					},
				},
				description: 'Prefix for name of the binary property to which to<br />write the attachments. An index starting with 0 will be added.<br />So if name is "attachment_" the first attachment is saved to "attachment_0"',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Ignore SSL Issues',
						name: 'allowUnauthorizedCerts',
						type: 'boolean',
						default: false,
						description: 'Do connect even if SSL certificate validation is not possible.',
					},
				],
			},
		],
	};



	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const credentials = this.getCredentials('imap');

		if (credentials === undefined) {
			throw new Error('No credentials got returned!');
		}

		const mailbox = this.getNodeParameter('mailbox') as string;
		const postProcessAction = this.getNodeParameter('postProcessAction') as string;
		const options = this.getNodeParameter('options', {}) as IDataObject;


		// Returns the email text
		const getText = async (parts: any[], message: Message, subtype: string) => { // tslint:disable-line:no-any
			if (!message.attributes.struct) {
				return '';
			}

			const textParts = parts.filter((part) => {
				return part.type.toUpperCase() === 'TEXT' && part.subtype.toUpperCase() === subtype.toUpperCase();
			});

			if (textParts.length === 0) {
				return '';
			}

			return await connection.getPartData(message, textParts[0]);
		};


		// Returns the email attachments
		const getAttachment = async (connection: ImapSimple, parts: any[], message: Message): Promise<IBinaryData[]> => { // tslint:disable-line:no-any
			if (!message.attributes.struct) {
				return [];
			}

			// Check if the message has attachments and if so get them
			const attachmentParts = parts.filter((part) => {
				return part.disposition && part.disposition.type.toUpperCase() === 'ATTACHMENT';
			});

			const attachmentPromises = [];
			let attachmentPromise;
			for (const attachmentPart of attachmentParts) {
				attachmentPromise = connection.getPartData(message, attachmentPart)
					.then((partData) => {
						// Return it in the format n8n expects
						return this.helpers.prepareBinaryData(partData, attachmentPart.disposition.params.filename);
					});

				attachmentPromises.push(attachmentPromise);
			}

			return Promise.all(attachmentPromises);
		};


		// Returns all the new unseen messages
		const getNewEmails = async (connection: ImapSimple): Promise<INodeExecutionData[]> => {
			const format = this.getNodeParameter('format', 0) as string;
			const searchCriteria = [
				'UNSEEN'
			];

			let fetchOptions = {};

			if (format === 'simple' || format === 'raw') {
				fetchOptions = {
					bodies: ['TEXT', 'HEADER'],
					markSeen: postProcessAction === 'read',
					struct: true,
				};
			} else if (format === 'resolved') {
				fetchOptions = {
					bodies: [''],
					markSeen: postProcessAction === 'read',
					struct: true,
				};
			}

			const results = await connection.search(searchCriteria, fetchOptions);

			const newEmails: INodeExecutionData[] = [];
			let newEmail: INodeExecutionData, messageHeader, messageBody;
			let attachments: IBinaryData[];
			let propertyName: string;



			// All properties get by default moved to metadata except the ones
			// which are defined here which get set on the top level.
			const topLevelProperties = [
				'cc',
				'date',
				'from',
				'subject',
				'to',
			];

			if (format === 'resolved') {
				const dataPropertyAttachmentsPrefixName = this.getNodeParameter('dataPropertyAttachmentsPrefixName') as string;

				for (const message of results) {
					const part = lodash.find(message.parts, {which: ''});

					if (part === undefined) {
						throw new Error('Email part could not be parsed.');
					}
					const parsedEmail = await parseRawEmail.call(this, part.body, dataPropertyAttachmentsPrefixName);

					newEmails.push(parsedEmail);
				}
			} else if (format === 'simple') {
				const downloadAttachments = this.getNodeParameter('downloadAttachments') as boolean;

				let dataPropertyAttachmentsPrefixName = '';
				if (downloadAttachments === true) {
					dataPropertyAttachmentsPrefixName = this.getNodeParameter('dataPropertyAttachmentsPrefixName') as string;
				}

				for (const message of results) {
					const parts = getParts(message.attributes.struct!);

					newEmail = {
						json: {
							textHtml: await getText(parts, message, 'html'),
							textPlain: await getText(parts, message, 'plain'),
							metadata: {} as IDataObject,
						}
					};

					messageHeader = message.parts.filter((part) => {
						return part.which === 'HEADER';
					});

					messageBody = messageHeader[0].body;
					for (propertyName of Object.keys(messageBody)) {
						if (messageBody[propertyName].length) {
							if (topLevelProperties.includes(propertyName)) {
								newEmail.json[propertyName] = messageBody[propertyName][0];
							} else {
								(newEmail.json.metadata as IDataObject)[propertyName] = messageBody[propertyName][0];
							}
						}
					}

					if (downloadAttachments === true) {
						// Get attachments and add them if any get found
						attachments = await getAttachment(connection, parts, message);
						if (attachments.length) {
							newEmail.binary = {};
							for (let i = 0; i < attachments.length; i++) {
								newEmail.binary[`${dataPropertyAttachmentsPrefixName}${i}`] = attachments[i];
							}
						}
					}

					newEmails.push(newEmail);
				}
			} else if (format === 'raw') {
				for (const message of results) {
					const part = lodash.find(message.parts, {which: 'TEXT'});

					if (part === undefined) {
						throw new Error('Email part could not be parsed.');
					}
					// Return base64 string
					newEmail = {
						json: {
							raw: part.body
						}
					};

					newEmails.push(newEmail);
				}
			}

			return newEmails;
		};



		let connection: ImapSimple;

		const config: ImapSimpleOptions = {
			imap: {
				user: credentials.user as string,
				password: credentials.password as string,
				host: credentials.host as string,
				port: credentials.port as number,
				tls: credentials.secure as boolean,
				authTimeout: 3000
			},
			onmail: async () => {
				const returnData = await getNewEmails(connection);

				if (returnData.length) {
					this.emit([returnData]);
				}
			},
		};

		if (options.allowUnauthorizedCerts === true) {
			config.imap.tlsOptions = {
				rejectUnauthorized: false
			};
		}

		// Connect to the IMAP server and open the mailbox
		// that we get informed whenever a new email arrives
		connection = await imapConnect(config);
		await connection.openBox(mailbox);


		// When workflow and so node gets set to inactive close the connectoin
		async function closeFunction() {
			await connection.end();
		}

		return {
			closeFunction,
		};

	}
}

export async function parseRawEmail(this: ITriggerFunctions, messageEncoded: ParserSource, dataPropertyNameDownload: string): Promise<INodeExecutionData> {
	const responseData = await simpleParser(messageEncoded);
	const headers: IDataObject = {};
	for (const header of responseData.headerLines) {
		headers[header.key] = header.line;
	}

	// @ts-ignore
	responseData.headers = headers;
	// @ts-ignore
	responseData.headerLines = undefined;

	const binaryData: IBinaryKeyData = {};
	if (responseData.attachments) {

		for (let i = 0; i < responseData.attachments.length; i++) {
			const attachment = responseData.attachments[i];
			binaryData[`${dataPropertyNameDownload}${i}`] = await this.helpers.prepareBinaryData(attachment.content, attachment.filename, attachment.contentType);
		}
		// @ts-ignore
		responseData.attachments = undefined;
	}

	return {
		json: responseData as unknown as IDataObject,
		binary: Object.keys(binaryData).length ? binaryData : undefined,
	} as INodeExecutionData;
}
