const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { takeSnapshot, revertToSnapshot } = require("../helpers/snapshot");
const { impersonateAccount } = require("../helpers/account");
const {
  signLoanTerms,
  signExtendLoanTerms,
  signIncreaseLoanTerms,
} = require("../helpers/sign");
const constants = require("../constants");
const { increaseTime } = require("../helpers/time");

const INVALID_SIGNATURE1 = "0x0000";
const INVALID_SIGNATURE2 =
  "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

describe("Spice Lending", function () {
  let vault;
  let lending;
  let note;
  let nft1, nft2;
  let weth;
  let spiceNft;
  let admin, alice, bob, strategist, assetReceiver, signer, spiceAdmin;
  let whale;
  let snapshotId;

  let defaultAdminRole, spiceRole, spiceNftRole;

  async function deployNFT() {
    const TestERC721 = await ethers.getContractFactory("TestERC721");
    const nft = await TestERC721.deploy("TestNFT", "NFT", "baseuri");

    return nft;
  }

  async function checkRole(contract, user, role, check) {
    expect(await contract.hasRole(role, user)).to.equal(check);
  }

  before("Deploy", async function () {
    [admin, alice, bob, strategist, assetReceiver, signer, spiceAdmin] =
      await ethers.getSigners();
    whale = await ethers.getSigner(constants.accounts.Whale1);
    await impersonateAccount(constants.accounts.Whale1);

    nft1 = await deployNFT();
    nft2 = await deployNFT();

    await nft1.mint(alice.address, 1);
    await nft1.mint(alice.address, 2);
    await nft1.mint(alice.address, 3);
    await nft2.mint(alice.address, 1);
    await nft2.mint(alice.address, 2);
    await nft2.mint(alice.address, 3);

    weth = await ethers.getContractAt("IWETH", constants.tokens.WETH, admin);

    await weth
      .connect(whale)
      .transfer(signer.address, ethers.utils.parseEther("100"));

    const SpiceFiNFT4626 = await ethers.getContractFactory("SpiceFiNFT4626");

    spiceNft = await upgrades.deployProxy(
      SpiceFiNFT4626,
      [strategist.address, assetReceiver.address, 700],
      {
        unsafeAllow: ["delegatecall"],
        kind: "uups",
      }
    );

    const Note = await ethers.getContractFactory("Note");

    note = await Note.deploy("Spice Note", "Spice Note");
    await note.deployed();

    const SpiceLending = await ethers.getContractFactory("SpiceLending");

    await expect(
      upgrades.deployProxy(
        SpiceLending,
        [ethers.constants.AddressZero, note.address, 500, 8000],
        {
          kind: "uups",
        }
      )
    ).to.be.revertedWithCustomError(SpiceLending, "InvalidAddress");

    await expect(
      upgrades.deployProxy(
        SpiceLending,
        [signer.address, ethers.constants.AddressZero, 500, 8000],
        {
          kind: "uups",
        }
      )
    ).to.be.revertedWithCustomError(SpiceLending, "InvalidAddress");

    await expect(
      upgrades.deployProxy(
        SpiceLending,
        [signer.address, note.address, 10001, 8000],
        {
          kind: "uups",
        }
      )
    ).to.be.revertedWithCustomError(SpiceLending, "ParameterOutOfBounds");

    await expect(
      upgrades.deployProxy(
        SpiceLending,
        [signer.address, note.address, 500, 10001],
        {
          kind: "uups",
        }
      )
    ).to.be.revertedWithCustomError(SpiceLending, "ParameterOutOfBounds");

    lending = await upgrades.deployProxy(
      SpiceLending,
      [signer.address, note.address, 500, 8000],
      {
        kind: "uups",
      }
    );

    defaultAdminRole = await lending.DEFAULT_ADMIN_ROLE();
    spiceRole = await lending.SPICE_ROLE();
    spiceNftRole = await lending.SPICE_NFT_ROLE();

    await lending.connect(admin).grantRole(spiceRole, spiceAdmin.address);
    await lending.connect(admin).grantRole(spiceNftRole, spiceNft.address);

    await note.initialize(lending.address);

    const adminRole = await note.ADMIN_ROLE();
    await checkRole(note, lending.address, adminRole, true);

    await spiceNft.grantRole(spiceRole, spiceAdmin.address);

    const amount = ethers.utils.parseEther("100");
    await weth
      .connect(whale)
      .transfer(alice.address, amount.add(ethers.utils.parseEther("0.08")));
    await weth
      .connect(alice)
      .approve(spiceNft.address, ethers.constants.MaxUint256);
    await spiceNft.connect(alice)["deposit(uint256,uint256)"](0, amount);

    await spiceNft.setBaseURI("uri://");
    await spiceNft.setWithdrawable(true);
  });

  beforeEach(async () => {
    snapshotId = await takeSnapshot();
  });

  afterEach(async function () {
    await revertToSnapshot(snapshotId);
  });

  describe("Deployment", function () {
    it("Should set the correct signer", async function () {
      expect(await lending["signer()"]()).to.equal(signer.address);
    });

    it("Should set the correct note", async function () {
      expect(await lending.note()).to.equal(note.address);
    });

    it("Should set the correct interest fee", async function () {
      expect(await lending.interestFee()).to.equal(500);
    });

    it("Should set the correct liquidation ratio", async function () {
      expect(await lending.liquidationRatio()).to.equal(8000);
    });

    it("Should initialize once", async function () {
      await expect(
        lending.initialize(signer.address, note.address, 500, 8000)
      ).to.be.revertedWith("Initializable: contract is already initialized");
    });

    it("Should be upgraded only by default admin", async function () {
      let SpiceLending = await ethers.getContractFactory("SpiceLending", alice);

      await expect(
        upgrades.upgradeProxy(lending.address, SpiceLending)
      ).to.be.revertedWith(
        `AccessControl: account ${alice.address.toLowerCase()} is missing role ${defaultAdminRole}`
      );

      SpiceLending = await ethers.getContractFactory("SpiceLending", admin);

      await upgrades.upgradeProxy(lending.address, SpiceLending);
    });
  });

  describe("Setters", function () {
    describe("Set Signer", function () {
      it("Only admin call call", async function () {
        await expect(
          lending.connect(alice).setSigner(bob.address)
        ).to.be.revertedWith(
          `AccessControl: account ${alice.address.toLowerCase()} is missing role ${defaultAdminRole}`
        );
      });

      it("Should not set zero address", async function () {
        await expect(
          lending.connect(admin).setSigner(ethers.constants.AddressZero)
        ).to.be.revertedWithCustomError(lending, "InvalidAddress");
      });

      it("Should set new signer address", async function () {
        await lending.connect(admin).setSigner(bob.address);
        expect(await lending["signer()"]()).to.equal(bob.address);
      });
    });

    describe("Set Interest Fee", function () {
      it("Only admin call call", async function () {
        await expect(
          lending.connect(alice).setInterestFee(1000)
        ).to.be.revertedWith(
          `AccessControl: account ${alice.address.toLowerCase()} is missing role ${defaultAdminRole}`
        );
      });

      it("Should not set bigger than DENOMINATOR", async function () {
        await expect(
          lending.connect(admin).setInterestFee(10001)
        ).to.be.revertedWithCustomError(lending, "ParameterOutOfBounds");
      });

      it("Should set new interest fee", async function () {
        const tx = await lending.connect(admin).setInterestFee(1000);
        expect(await lending.interestFee()).to.equal(1000);
        await expect(tx).to.emit(lending, "InterestFeeUpdated").withArgs(1000);
      });
    });

    describe("Set Liquidation Ratio", function () {
      it("Only admin call call", async function () {
        await expect(
          lending.connect(alice).setLiquidationRatio(7000)
        ).to.be.revertedWith(
          `AccessControl: account ${alice.address.toLowerCase()} is missing role ${defaultAdminRole}`
        );
      });

      it("Should not set bigger than DENOMINATOR", async function () {
        await expect(
          lending.connect(admin).setLiquidationRatio(10001)
        ).to.be.revertedWithCustomError(lending, "ParameterOutOfBounds");
      });

      it("Should set new liquidation ratio", async function () {
        const tx = await lending.connect(admin).setLiquidationRatio(7000);
        expect(await lending.liquidationRatio()).to.equal(7000);
        await expect(tx)
          .to.emit(lending, "LiquidationRatioUpdated")
          .withArgs(7000);
      });
    });
  });

  describe("Initiate Loan", function () {
    let loanTerms;

    beforeEach(function () {
      loanTerms = {
        baseTerms: {
          collateralAddress: nft1.address,
          collateralId: 1,
          expiration: Math.floor(Date.now() / 1000) + 30 * 60,
          lender: signer.address,
          borrower: alice.address,
        },
        principal: ethers.utils.parseEther("10"),
        interestRate: 500,
        duration: 10 * 24 * 3600, // 10 days
        currency: weth.address,
      };
    });

    it("When loan terms expired", async function () {
      loanTerms.baseTerms.expiration = Math.floor(Date.now() / 1000) - 10 * 60;
      const signature = await signLoanTerms(signer, lending.address, loanTerms);
      await expect(
        lending.connect(alice).initiateLoan(loanTerms, signature)
      ).to.be.revertedWithCustomError(lending, "LoanTermsExpired");
    });

    it("When signature is invalid #1", async function () {
      const signature = INVALID_SIGNATURE1;
      await expect(
        lending.connect(alice).initiateLoan(loanTerms, signature)
      ).to.be.revertedWith("ECDSA: invalid signature length");
    });

    it("When signature is invalid #2", async function () {
      const signature = INVALID_SIGNATURE2;
      await expect(
        lending.connect(alice).initiateLoan(loanTerms, signature)
      ).to.be.revertedWith("ECDSA: invalid signature 'v' value");
    });

    it("When signature is invalid #3", async function () {
      const signature = await signLoanTerms(bob, lending.address, loanTerms);
      await expect(
        lending.connect(alice).initiateLoan(loanTerms, signature)
      ).to.be.revertedWithCustomError(lending, "InvalidSignature");
    });

    it("When collateral is not approved", async function () {
      const signature = await signLoanTerms(signer, lending.address, loanTerms);
      await expect(
        lending.connect(alice).initiateLoan(loanTerms, signature)
      ).to.be.revertedWith("ERC721: caller is not token owner nor approved");
    });

    it("When currency is not approved", async function () {
      await nft1.connect(alice).setApprovalForAll(lending.address, true);
      const signature = await signLoanTerms(signer, lending.address, loanTerms);
      await expect(
        lending.connect(alice).initiateLoan(loanTerms, signature)
      ).to.be.revertedWith("SafeERC20: low-level call failed");
    });

    it("Initiates a new loan and transfer tokens", async function () {
      await nft1.connect(alice).setApprovalForAll(lending.address, true);
      await weth
        .connect(signer)
        .approve(lending.address, ethers.constants.MaxUint256);
      const signature = await signLoanTerms(signer, lending.address, loanTerms);
      const loanId = await lending
        .connect(alice)
        .callStatic.initiateLoan(loanTerms, signature);
      const tx = await lending
        .connect(alice)
        .initiateLoan(loanTerms, signature);

      await expect(tx)
        .to.emit(lending, "LoanStarted")
        .withArgs(loanId, alice.address);

      expect(await note.ownerOf(loanId)).to.be.eq(signer.address);
      expect(await weth.balanceOf(alice.address)).to.be.eq(loanTerms.principal);
      expect(await nft1.ownerOf(1)).to.be.eq(lending.address);

      const loanData = await lending.getLoanData(loanId);
      expect(loanData.state).to.be.eq(1);
      expect(loanData.balance).to.be.eq(loanTerms.principal);
      expect(loanData.interestAccrued).to.be.eq(0);
      expect(loanData.startedAt).to.be.eq(loanData.updatedAt);
    });
  });

  describe("Extend Loan", function () {
    let loanId;
    let terms;

    beforeEach(async function () {
      const loanTerms = {
        baseTerms: {
          collateralAddress: nft1.address,
          collateralId: 1,
          expiration: Math.floor(Date.now() / 1000) + 30 * 60,
          lender: signer.address,
          borrower: alice.address,
        },
        principal: ethers.utils.parseEther("10"),
        interestRate: 500,
        duration: 10 * 24 * 3600, // 10 days
        currency: weth.address,
      };
      await nft1.connect(alice).setApprovalForAll(lending.address, true);
      await weth
        .connect(signer)
        .approve(lending.address, ethers.constants.MaxUint256);
      const signature = await signLoanTerms(signer, lending.address, loanTerms);
      loanId = await lending
        .connect(alice)
        .callStatic.initiateLoan(loanTerms, signature);
      await lending.connect(alice).initiateLoan(loanTerms, signature);

      terms = {
        baseTerms: {
          collateralAddress: nft1.address,
          collateralId: 1,
          expiration: Math.floor(Date.now() / 1000) + 30 * 60,
          lender: signer.address,
          borrower: alice.address,
        },
        additionalPrincipal: ethers.utils.parseEther("2"),
        newInterestRate: 550,
        additionalDuration: 2 * 24 * 3600, // 10 days
      };
    });

    it("When loan is not active", async function () {
      await expect(lending.connect(alice).extendLoan(loanId + 1, terms, "0x"))
        .to.be.revertedWithCustomError(lending, "InvalidState")
        .withArgs(0);
    });

    it("When caller is not borrower", async function () {
      await expect(
        lending.connect(bob).extendLoan(loanId, terms, "0x")
      ).to.be.revertedWithCustomError(lending, "InvalidMsgSender");
    });

    it("When loan terms expired", async function () {
      terms.baseTerms.expiration = Math.floor(Date.now() / 1000) - 10 * 60;
      const signature = await signExtendLoanTerms(
        signer,
        lending.address,
        terms
      );
      await expect(
        lending.connect(alice).extendLoan(loanId, terms, signature)
      ).to.be.revertedWithCustomError(lending, "LoanTermsExpired");
    });

    it("When signature is invalid #1", async function () {
      const signature = INVALID_SIGNATURE1;
      await expect(
        lending.connect(alice).extendLoan(loanId, terms, signature)
      ).to.be.revertedWith("ECDSA: invalid signature length");
    });

    it("When signature is invalid #2", async function () {
      const signature = INVALID_SIGNATURE2;
      await expect(
        lending.connect(alice).extendLoan(loanId, terms, signature)
      ).to.be.revertedWith("ECDSA: invalid signature 'v' value");
    });

    it("When signature is invalid #3", async function () {
      const signature = await signExtendLoanTerms(bob, lending.address, terms);
      await expect(
        lending.connect(alice).extendLoan(loanId, terms, signature)
      ).to.be.revertedWithCustomError(lending, "InvalidSignature");
    });

    it("When currency is not approved", async function () {
      await weth.connect(signer).approve(lending.address, 0);
      const signature = await signExtendLoanTerms(
        signer,
        lending.address,
        terms
      );
      await expect(
        lending.connect(alice).extendLoan(loanId, terms, signature)
      ).to.be.revertedWith("SafeERC20: low-level call failed");
    });

    it("Extends loan and transfer additional principal", async function () {
      await weth.connect(signer).approve(lending.address, 0);
      await weth
        .connect(signer)
        .approve(lending.address, ethers.constants.MaxUint256);
      const beforeBalance = await weth.balanceOf(alice.address);
      const oldLoanData = await lending.getLoanData(loanId);
      const signature = await signExtendLoanTerms(
        signer,
        lending.address,
        terms
      );
      const tx = await lending
        .connect(alice)
        .extendLoan(loanId, terms, signature);
      await expect(tx).to.emit(lending, "LoanExtended").withArgs(loanId);
      expect(await weth.balanceOf(alice.address)).to.be.eq(
        beforeBalance.add(terms.additionalPrincipal)
      );
      const newLoanData = await lending.getLoanData(loanId);
      expect(newLoanData.balance).to.be.eq(
        oldLoanData.balance.add(terms.additionalPrincipal)
      );
      expect(newLoanData.terms.principal).to.be.eq(
        oldLoanData.terms.principal.add(terms.additionalPrincipal)
      );
      expect(newLoanData.terms.duration).to.be.eq(
        oldLoanData.terms.duration + terms.additionalDuration
      );
      expect(newLoanData.terms.interestRate).to.be.eq(terms.newInterestRate);
    });
  });

  describe("Increase Loan", function () {
    let loanId;
    let terms;

    beforeEach(async function () {
      const loanTerms = {
        baseTerms: {
          collateralAddress: nft1.address,
          collateralId: 1,
          expiration: Math.floor(Date.now() / 1000) + 30 * 60,
          lender: signer.address,
          borrower: alice.address,
        },
        principal: ethers.utils.parseEther("10"),
        interestRate: 500,
        duration: 10 * 24 * 3600, // 10 days
        currency: weth.address,
      };
      await nft1.connect(alice).setApprovalForAll(lending.address, true);
      await weth
        .connect(signer)
        .approve(lending.address, ethers.constants.MaxUint256);
      const signature = await signLoanTerms(signer, lending.address, loanTerms);
      loanId = await lending
        .connect(alice)
        .callStatic.initiateLoan(loanTerms, signature);
      await lending.connect(alice).initiateLoan(loanTerms, signature);

      terms = {
        baseTerms: {
          collateralAddress: nft1.address,
          collateralId: 1,
          expiration: Math.floor(Date.now() / 1000) + 30 * 60,
          lender: signer.address,
          borrower: alice.address,
        },
        additionalPrincipal: ethers.utils.parseEther("2"),
        newInterestRate: 550,
      };
    });

    it("When loan is not active", async function () {
      await expect(lending.connect(alice).increaseLoan(loanId + 1, terms, "0x"))
        .to.be.revertedWithCustomError(lending, "InvalidState")
        .withArgs(0);
    });

    it("When caller is not borrower", async function () {
      await expect(
        lending.connect(bob).increaseLoan(loanId, terms, "0x")
      ).to.be.revertedWithCustomError(lending, "InvalidMsgSender");
    });

    it("When loan terms expired", async function () {
      terms.baseTerms.expiration = Math.floor(Date.now() / 1000) - 10 * 60;
      const signature = await signIncreaseLoanTerms(
        signer,
        lending.address,
        terms
      );
      await expect(
        lending.connect(alice).increaseLoan(loanId, terms, signature)
      ).to.be.revertedWithCustomError(lending, "LoanTermsExpired");
    });

    it("When signature is invalid #1", async function () {
      const signature = INVALID_SIGNATURE1;
      await expect(
        lending.connect(alice).increaseLoan(loanId, terms, signature)
      ).to.be.revertedWith("ECDSA: invalid signature length");
    });

    it("When signature is invalid #2", async function () {
      const signature = INVALID_SIGNATURE2;
      await expect(
        lending.connect(alice).increaseLoan(loanId, terms, signature)
      ).to.be.revertedWith("ECDSA: invalid signature 'v' value");
    });

    it("When signature is invalid #3", async function () {
      const signature = await signIncreaseLoanTerms(
        bob,
        lending.address,
        terms
      );
      await expect(
        lending.connect(alice).increaseLoan(loanId, terms, signature)
      ).to.be.revertedWithCustomError(lending, "InvalidSignature");
    });

    it("When currency is not approved", async function () {
      await weth.connect(signer).approve(lending.address, 0);
      const signature = await signIncreaseLoanTerms(
        signer,
        lending.address,
        terms
      );
      await expect(
        lending.connect(alice).increaseLoan(loanId, terms, signature)
      ).to.be.revertedWith("SafeERC20: low-level call failed");
    });

    it("Increase loan and transfer additional principal", async function () {
      await weth.connect(signer).approve(lending.address, 0);
      await weth
        .connect(signer)
        .approve(lending.address, ethers.constants.MaxUint256);
      const beforeBalance = await weth.balanceOf(alice.address);
      const oldLoanData = await lending.getLoanData(loanId);
      const signature = await signIncreaseLoanTerms(
        signer,
        lending.address,
        terms
      );
      const tx = await lending
        .connect(alice)
        .increaseLoan(loanId, terms, signature);
      await expect(tx).to.emit(lending, "LoanIncreased").withArgs(loanId);
      expect(await weth.balanceOf(alice.address)).to.be.eq(
        beforeBalance.add(terms.additionalPrincipal)
      );
      const newLoanData = await lending.getLoanData(loanId);
      expect(newLoanData.balance).to.be.eq(
        oldLoanData.balance.add(terms.additionalPrincipal)
      );
      expect(newLoanData.terms.principal).to.be.eq(
        oldLoanData.terms.principal.add(terms.additionalPrincipal)
      );
      expect(newLoanData.terms.duration).to.be.eq(oldLoanData.terms.duration);
      expect(newLoanData.terms.interestRate).to.be.eq(terms.newInterestRate);
    });
  });

  describe("Partial Repay", function () {
    let loanId1, loanId2;

    beforeEach(async function () {
      const loanTerms1 = {
        baseTerms: {
          collateralAddress: nft1.address,
          collateralId: 1,
          expiration: Math.floor(Date.now() / 1000) + 30 * 60,
          lender: signer.address,
          borrower: alice.address,
        },
        principal: ethers.utils.parseEther("10"),
        interestRate: 500,
        duration: 10 * 24 * 3600, // 10 days
        currency: weth.address,
      };
      await nft1.connect(alice).setApprovalForAll(lending.address, true);
      await weth
        .connect(signer)
        .approve(lending.address, ethers.constants.MaxUint256);
      const signature1 = await signLoanTerms(
        signer,
        lending.address,
        loanTerms1
      );
      loanId1 = await lending
        .connect(alice)
        .callStatic.initiateLoan(loanTerms1, signature1);
      await lending.connect(alice).initiateLoan(loanTerms1, signature1);

      const loanTerms2 = {
        baseTerms: {
          collateralAddress: spiceNft.address,
          collateralId: 1,
          expiration: Math.floor(Date.now() / 1000) + 30 * 60,
          lender: signer.address,
          borrower: alice.address,
        },
        principal: ethers.utils.parseEther("10"),
        interestRate: 500,
        duration: 10 * 24 * 3600, // 10 days
        currency: weth.address,
      };
      await spiceNft.connect(alice).setApprovalForAll(lending.address, true);
      const signature2 = await signLoanTerms(
        signer,
        lending.address,
        loanTerms2
      );
      loanId2 = await lending
        .connect(alice)
        .callStatic.initiateLoan(loanTerms2, signature2);
      await lending.connect(alice).initiateLoan(loanTerms2, signature2);
    });

    it("When loan is not active", async function () {
      const payment = ethers.utils.parseEther("5");
      await expect(lending.connect(alice).partialRepay(100, payment))
        .to.be.revertedWithCustomError(lending, "InvalidState")
        .withArgs(0);
    });

    it("When caller is not borrower", async function () {
      const payment = ethers.utils.parseEther("5");
      await expect(
        lending.connect(bob).partialRepay(loanId1, payment)
      ).to.be.revertedWithCustomError(lending, "InvalidMsgSender");
    });

    it("When partially repaying for normal NFT loan", async function () {
      await increaseTime(24 * 3600);

      await weth
        .connect(alice)
        .approve(lending.address, ethers.constants.MaxUint256);

      const beforeBalance = await weth.balanceOf(alice.address);

      const payment = ethers.utils.parseEther("5");
      const tx = await lending.connect(alice).partialRepay(loanId1, payment);

      await expect(tx).to.emit(lending, "LoanRepaid").withArgs(loanId1);
      expect(await weth.balanceOf(alice.address)).to.be.eq(
        beforeBalance.sub(payment)
      );
      expect(await weth.balanceOf(spiceAdmin.address)).to.be.gt(0);
    });

    it("When partially repaying for Spice NFT loan", async function () {
      await increaseTime(24 * 3600);

      await weth
        .connect(alice)
        .approve(lending.address, ethers.constants.MaxUint256);

      const beforeBalance = await weth.balanceOf(alice.address);
      let shares = await spiceNft.tokenShares(1);
      const beforeWithdrawable = await spiceNft.previewRedeem(shares);

      const payment = ethers.utils.parseEther("5");
      const tx = await lending.connect(alice).partialRepay(loanId2, payment);

      await expect(tx).to.emit(lending, "LoanRepaid").withArgs(loanId2);
      expect(await weth.balanceOf(alice.address)).to.be.eq(beforeBalance);
      expect(await weth.balanceOf(spiceAdmin.address)).to.be.gt(0);

      shares = await spiceNft.tokenShares(1);
      const afterWithdrawable = await spiceNft.previewRedeem(shares);
      expect(beforeWithdrawable).to.be.eq(afterWithdrawable.add(payment));
    });

    it("When repaying very small payment", async function () {
      await increaseTime(24 * 3600);

      await weth
        .connect(alice)
        .approve(lending.address, ethers.constants.MaxUint256);

      const beforeBalance = await weth.balanceOf(alice.address);

      const payment = 10000;
      const tx = await lending.connect(alice).partialRepay(loanId1, payment);

      await expect(tx).to.emit(lending, "LoanRepaid").withArgs(loanId1);
      expect(await weth.balanceOf(alice.address)).to.be.eq(
        beforeBalance.sub(payment)
      );
      expect(await weth.balanceOf(spiceAdmin.address)).to.be.gt(0);
    });

    it("When repaying full payment", async function () {
      await increaseTime(24 * 3600);

      await weth
        .connect(alice)
        .approve(lending.address, ethers.constants.MaxUint256);

      const beforeBalance = await weth.balanceOf(alice.address);

      const payment = ethers.utils.parseEther("11");
      const tx = await lending.connect(alice).partialRepay(loanId1, payment);

      await expect(tx).to.emit(lending, "LoanRepaid").withArgs(loanId1);
      expect(await weth.balanceOf(alice.address)).to.be.gt(
        beforeBalance.sub(payment)
      );
      expect(await weth.balanceOf(spiceAdmin.address)).to.be.gt(0);

      const loanData = await lending.getLoanData(loanId1);
      expect(loanData.state).to.be.eq(2);
      expect(loanData.interestAccrued).to.be.eq(0);

      expect(await nft1.ownerOf(1)).to.be.eq(alice.address);
      await expect(note.ownerOf(loanId1)).to.be.revertedWith(
        "ERC721: invalid token ID"
      );
    });
  });

  describe("Repay", function () {
    let loanId1, loanId2;

    beforeEach(async function () {
      const loanTerms1 = {
        baseTerms: {
          collateralAddress: nft1.address,
          collateralId: 1,
          expiration: Math.floor(Date.now() / 1000) + 30 * 60,
          lender: signer.address,
          borrower: alice.address,
        },
        principal: ethers.utils.parseEther("10"),
        interestRate: 500,
        duration: 10 * 24 * 3600, // 10 days
        currency: weth.address,
      };
      await nft1.connect(alice).setApprovalForAll(lending.address, true);
      await weth
        .connect(signer)
        .approve(lending.address, ethers.constants.MaxUint256);
      const signature1 = await signLoanTerms(
        signer,
        lending.address,
        loanTerms1
      );
      loanId1 = await lending
        .connect(alice)
        .callStatic.initiateLoan(loanTerms1, signature1);
      await lending.connect(alice).initiateLoan(loanTerms1, signature1);

      const loanTerms2 = {
        baseTerms: {
          collateralAddress: spiceNft.address,
          collateralId: 1,
          expiration: Math.floor(Date.now() / 1000) + 30 * 60,
          lender: signer.address,
          borrower: alice.address,
        },
        principal: ethers.utils.parseEther("10"),
        interestRate: 500,
        duration: 10 * 24 * 3600, // 10 days
        currency: weth.address,
      };
      await spiceNft.connect(alice).setApprovalForAll(lending.address, true);
      const signature2 = await signLoanTerms(
        signer,
        lending.address,
        loanTerms2
      );
      loanId2 = await lending
        .connect(alice)
        .callStatic.initiateLoan(loanTerms2, signature2);
      await lending.connect(alice).initiateLoan(loanTerms2, signature2);
    });

    it("When loan is not active", async function () {
      await expect(lending.connect(alice).repay(100))
        .to.be.revertedWithCustomError(lending, "InvalidState")
        .withArgs(0);
    });

    it("When caller is not borrower", async function () {
      await expect(
        lending.connect(bob).repay(loanId1)
      ).to.be.revertedWithCustomError(lending, "InvalidMsgSender");
    });

    it("When repaying for normal NFT loan", async function () {
      await increaseTime(24 * 3600);

      await weth
        .connect(alice)
        .approve(lending.address, ethers.constants.MaxUint256);

      const beforeBalance = await weth.balanceOf(alice.address);

      const tx = await lending.connect(alice).repay(loanId1);

      await expect(tx).to.emit(lending, "LoanRepaid").withArgs(loanId1);
      expect(await weth.balanceOf(alice.address)).to.be.lt(beforeBalance);
      expect(await weth.balanceOf(spiceAdmin.address)).to.be.gt(0);
    });

    it("When repaying for Spice NFT loan", async function () {
      await increaseTime(24 * 3600);

      await weth
        .connect(alice)
        .approve(lending.address, ethers.constants.MaxUint256);

      const beforeBalance = await weth.balanceOf(alice.address);
      let shares = await spiceNft.tokenShares(1);
      const beforeWithdrawable = await spiceNft.previewRedeem(shares);

      const tx = await lending.connect(alice).repay(loanId2);

      await expect(tx).to.emit(lending, "LoanRepaid").withArgs(loanId2);
      expect(await weth.balanceOf(alice.address)).to.be.eq(beforeBalance);
      expect(await weth.balanceOf(spiceAdmin.address)).to.be.gt(0);

      shares = await spiceNft.tokenShares(1);
      const afterWithdrawable = await spiceNft.previewRedeem(shares);
      expect(beforeWithdrawable).to.be.gt(afterWithdrawable);
    });

    it("Should burn note and transfer collateral", async function () {
      await increaseTime(24 * 3600);

      await weth
        .connect(alice)
        .approve(lending.address, ethers.constants.MaxUint256);

      await lending.connect(alice).repay(loanId1);

      const loanData = await lending.getLoanData(loanId1);
      expect(loanData.state).to.be.eq(2);
      expect(loanData.interestAccrued).to.be.eq(0);

      expect(await nft1.ownerOf(1)).to.be.eq(alice.address);
      await expect(note.ownerOf(loanId1)).to.be.revertedWith(
        "ERC721: invalid token ID"
      );
    });
  });
});
