import { Request, Response } from "express";
import { prisma } from "../config/prisma";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";

// Email configuration
const transporter = nodemailer.createTransport({
  service: "gmail",
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false, // Fixes the self-signed certificate issue
  },
});

// Generate OTP
const generateOTP = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Send OTP email
const sendOTPEmail = async (email: string, otp: string) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: "Password Reset OTP",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Password Reset Request</h2>
        <p>You have requested to reset your password. Use the following OTP to proceed:</p>
        <div style="background-color: #f4f4f4; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 5px;">
          ${otp}
        </div>
        <p>This OTP will expire in 15 minutes.</p>
        <p>If you didn't request this, please ignore this email.</p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};

export const getUser = async (req: Request, res: Response): Promise<void> => {
  try {
    res.status(200).json({ message: "User fetched successfully" });
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    // First check User table
    let user = await prisma.user.findUnique({
      where: { email },
    });

    // If not found in User table, check Admin table
    if (!user) {
      const admin = await prisma.admin.findUnique({
        where: { email },
      });

      if (!admin) {
        res.status(401).json({ message: "Invalid credentials" });
        return;
      }

      console.log("Admin found:", !!admin); // Debug log
      console.log("Stored hashed password:", admin.password); // Debug log
      console.log("Provided password:", password); // Debug log

      // Verify admin password
      const validPassword = await bcrypt.compare(password, admin.password);
      console.log("Password valid:", validPassword); // Debug log

      if (!validPassword) {
        res.status(401).json({ message: "Invalid credentials" });
        return;
      }

      // Generate token for admin
      const token = jwt.sign(
        {
          userId: admin.id,
          email: admin.email,
          role: "ADMIN",
          name: admin.name,
        },
        process.env.JWT_SECRET!,
        { expiresIn: "24h" }
      );

      res.status(200).json({
        success: true,
        message: "Login successful",
        token,
        user: {
          id: admin.id,
          email: admin.email,
          name: admin.name,
          role: "ADMIN",
        },
      });
      return;
    }

    // Continue with existing user login logic...
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, name: user.name },
      process.env.JWT_SECRET || "fallback-secret",
      { expiresIn: "24h" }
    );

    res.status(200).json({
      message: "Login successful",
      token,
      user: { id: user.id, email: user.email },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error during login",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const forgotPassword = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({ message: "Email is required" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await prisma.passwordReset.upsert({
      where: { userId: user.id },
      update: { otp, otpExpiry },
      create: { userId: user.id, otp, otpExpiry },
    });

    await sendOTPEmail(email, otp);

    res.status(200).json({
      message: "OTP sent to your email",
      email: user.email,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const confirmOTP = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      res.status(400).json({ message: "Email and OTP are required" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { passwordReset: true },
    });

    if (!user || !user.passwordReset) {
      res.status(400).json({ message: "Invalid reset request" });
      return;
    }

    if (user.passwordReset.otp !== otp) {
      res.status(400).json({ message: "Invalid OTP" });
      return;
    }

    if (user.passwordReset.otpExpiry < new Date()) {
      res.status(400).json({ message: "OTP has expired" });
      return;
    }

    res.status(200).json({
      message: "OTP verified successfully",
      email: user.email,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const resetPassword = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
      res.status(400).json({ message: "Email and new password are required" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { passwordReset: true },
    });

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { email },
      data: { password: hashedPassword },
    });

    // Clean up the password reset record
    if (user.passwordReset) {
      await prisma.passwordReset.delete({
        where: { userId: user.id },
      });
    }

    res.status(200).json({ message: "Password reset successful" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const changePassword = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { oldPassword, newPassword } = req.body;
    //console.log(req.body)
    const userId = req.user?.userId; // Changed from id to userId

    if (!userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    if (!oldPassword || !newPassword) {
      res
        .status(400)
        .json({ message: "Old password and new password are required" });
      return;
    }

    // Get user from database
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    // Verify old password
    const isOldPasswordValid = await bcrypt.compare(oldPassword, user.password);
    if (!isOldPasswordValid) {
      res.status(401).json({ message: "Current password is incorrect" });
      return;
    }

    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedNewPassword },
    });

    res.status(200).json({ message: "Password changed successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const searchUser = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const query = req.query.query as string;

    if (!query || typeof query !== "string") {
      res.status(400).json({ error: "Query parameter is required" });
    }

    const users = await prisma.user.findMany({
      where: {
        email: {
          contains: query, // Case-insensitive search
          mode: "insensitive",
        },
      },
      select: {
        id: true,
        name: true,
        email: true, // Include other fields if needed
      },
    });

    res.json(users);
  } catch (error) {
    console.error("Error searching users:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const updateUser = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { name } = req.body;

    if (!userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        name: name || undefined,
      },
      select: {
        id: true,
        name: true,
        email: true,
        isActivated: true,
        role: true,
        createdAt: true,
      },
    });

    res.status(200).json({
      success: true,
      message: "User updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error updating user",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getSubmissionCount = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        submission_count: true
      }
    });

    if (!user) {
      res.status(404).json({
        success: false,
        message: "User not found"
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        submission_count: user.submission_count
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Error fetching submission count",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};
