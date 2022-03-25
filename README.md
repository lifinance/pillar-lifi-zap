# Pillar LI.FI Zaps

The projects makes use of the LI.FI SDK to transfer funds cross chain and than uses the Etherspot SDK to exchange and stake those token for the user without the need to change the chain.


## Setup

Initially copy `.env.sample` to `.env` and add your wallets seed phrase. The wallet will be use to actually start the initial transfers, so it has to have FTM and USDC on Fantom.

Optionally: Use `nvm use` to select the used node version.

Install all dependencies using `yarn`.


## Usage

Use `yarn start` to execute the script.
